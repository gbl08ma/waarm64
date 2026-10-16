//! HTTP/2 inside the control server's Noise channel, sans I/O: the `h2` crate's client over an
//! in-memory pipe, driven without a runtime. Its futures are polled with a no-op waker after
//! every input (bytes from the server, a new request), until nothing moves; whatever h2 wrote
//! is then taken from the pipe and sealed for the wire by the caller. h2 keeps no timers of
//! its own here (no keep-alive pings are configured).

use std::{
    cell::RefCell,
    collections::{BTreeMap, VecDeque},
    future::Future,
    pin::Pin,
    rc::Rc,
    task::{Context, Poll, Waker},
};

use bytes::Bytes;
use h2::{
    RecvStream,
    client::{Connection, ResponseFuture, SendRequest},
};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

#[derive(Default)]
struct Buffers {
    input: VecDeque<u8>,
    output: Vec<u8>,
    eof: bool,
}

/// The connection's byte stream: what the server sent in, what h2 wrote out.
struct Pipe(Rc<RefCell<Buffers>>);

impl AsyncRead for Pipe {
    fn poll_read(
        self: Pin<&mut Self>,
        _: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let mut b = self.0.borrow_mut();
        if b.input.is_empty() {
            // Polled again after the next input; an empty read at EOF closes the connection.
            return if b.eof {
                Poll::Ready(Ok(()))
            } else {
                Poll::Pending
            };
        }
        let n = b.input.len().min(buf.remaining());
        let (front, back) = b.input.as_slices();
        let k = front.len().min(n);
        buf.put_slice(&front[..k]);
        buf.put_slice(&back[..n - k]);
        b.input.drain(..n);
        Poll::Ready(Ok(()))
    }
}

impl AsyncWrite for Pipe {
    fn poll_write(
        self: Pin<&mut Self>,
        _: &mut Context<'_>,
        data: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        self.0.borrow_mut().output.extend_from_slice(data);
        Poll::Ready(Ok(data.len()))
    }
    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }
    fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

type Handshake =
    Pin<Box<dyn Future<Output = Result<(SendRequest<Bytes>, Connection<Pipe, Bytes>), h2::Error>>>>;

/// What happened to a request.
#[derive(Debug, PartialEq)]
pub enum Event {
    /// The response's status.
    Status { id: u32, status: u16 },
    /// A piece of the response's body.
    Data { id: u32, data: Vec<u8> },
    /// The response is complete.
    End { id: u32 },
    /// The request failed (or the whole connection, with every request it carried).
    Failed { id: u32, error: String },
}

enum Req {
    Queued(Box<http::Request<()>>, Bytes),
    Waiting(ResponseFuture),
    Body(RecvStream),
}

pub struct Client {
    buf: Rc<RefCell<Buffers>>,
    handshake: Option<Handshake>,
    send: Option<SendRequest<Bytes>>,
    conn: Option<Pin<Box<Connection<Pipe, Bytes>>>>,
    /// The scheme and authority requests are addressed to (the control server's).
    origin: String,
    reqs: BTreeMap<u32, Req>,
    next: u32,
    failed: Option<String>,
}

impl Client {
    /// A client that will speak first (the preface and SETTINGS are in the first `output`).
    pub fn new(origin: &str) -> Self {
        let buf = Rc::new(RefCell::new(Buffers::default()));
        let handshake: Handshake = Box::pin(h2::client::handshake(Pipe(buf.clone())));
        let mut c = Client {
            buf,
            handshake: Some(handshake),
            send: None,
            conn: None,
            origin: origin.trim_end_matches('/').to_string(),
            reqs: BTreeMap::new(),
            next: 1,
            failed: None,
        };
        c.drive();
        c
    }

    /// Bytes from the server; then `poll` for what they did.
    pub fn input(&mut self, data: &[u8]) {
        self.buf.borrow_mut().input.extend(data);
    }

    /// The server closed the stream.
    pub fn eof(&mut self) {
        self.buf.borrow_mut().eof = true;
    }

    /// Queues `POST path` with `body` and `headers`; its events carry the returned ID.
    pub fn post(&mut self, path: &str, headers: &[(&str, &str)], body: Vec<u8>) -> u32 {
        let id = self.next;
        self.next += 1;
        let mut req = http::Request::post(format!("{}{path}", self.origin));
        for (k, v) in headers {
            req = req.header(*k, *v);
        }
        let req = req.body(()).expect("a valid request");
        self.reqs
            .insert(id, Req::Queued(Box::new(req), Bytes::from(body)));
        id
    }

    /// Drops a request (a long poll we no longer want).
    pub fn cancel(&mut self, id: u32) {
        self.reqs.remove(&id);
    }

    /// Bytes h2 wrote, for the wire.
    pub fn take_output(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.buf.borrow_mut().output)
    }

    /// Runs everything that can run; what happened to the requests.
    pub fn poll(&mut self) -> Vec<Event> {
        let mut events = Vec::new();
        loop {
            let before = (
                events.len(),
                self.buf.borrow().output.len(),
                self.buf.borrow().input.len(),
            );
            self.drive();
            if let Some(e) = self.failed.clone() {
                for (id, _) in std::mem::take(&mut self.reqs) {
                    events.push(Event::Failed {
                        id,
                        error: e.clone(),
                    });
                }
            }
            let moved = self.step(&mut events);
            let after = (
                events.len(),
                self.buf.borrow().output.len(),
                self.buf.borrow().input.len(),
            );
            if before == after && !moved {
                return events;
            }
        }
    }

    pub fn is_failed(&self) -> bool {
        self.failed.is_some()
    }

    /// Polls the handshake and the connection (which does all the reading and writing).
    fn drive(&mut self) {
        let mut cx = Context::from_waker(Waker::noop());
        if let Some(h) = self.handshake.as_mut() {
            match h.as_mut().poll(&mut cx) {
                Poll::Ready(Ok((send, conn))) => {
                    self.handshake = None;
                    self.send = Some(send);
                    self.conn = Some(Box::pin(conn));
                }
                Poll::Ready(Err(e)) => {
                    self.handshake = None;
                    self.failed = Some(format!("HTTP/2: {e}"));
                }
                Poll::Pending => {}
            }
        }
        if let Some(c) = self.conn.as_mut() {
            match c.as_mut().poll(&mut cx) {
                Poll::Ready(Ok(())) => {
                    self.conn = None;
                    self.failed
                        .get_or_insert_with(|| "the control connection closed".into());
                }
                Poll::Ready(Err(e)) => {
                    self.conn = None;
                    self.failed = Some(format!("HTTP/2: {e}"));
                }
                Poll::Pending => {}
            }
        }
    }

    /// Advances each request as far as it goes; whether any started (its frames are written
    /// when the connection is next polled).
    fn step(&mut self, events: &mut Vec<Event>) -> bool {
        let mut moved = false;
        let mut cx = Context::from_waker(Waker::noop());
        let ids: Vec<u32> = self.reqs.keys().copied().collect();
        for id in ids {
            let Some(r) = self.reqs.remove(&id) else {
                continue;
            };
            let next = match r {
                Req::Queued(req, body) => match self.send.as_mut().map(|s| s.poll_ready(&mut cx)) {
                    Some(Poll::Ready(Ok(()))) => {
                        let send = self.send.as_mut().unwrap();
                        match send.send_request(*req, body.is_empty()) {
                            Ok((resp, mut stream)) => {
                                if !body.is_empty() {
                                    stream.reserve_capacity(body.len());
                                    if let Err(e) = stream.send_data(body, true) {
                                        events.push(Event::Failed {
                                            id,
                                            error: format!("HTTP/2: {e}"),
                                        });
                                        continue;
                                    }
                                }
                                moved = true;
                                Some(Req::Waiting(resp))
                            }
                            Err(e) => {
                                events.push(Event::Failed {
                                    id,
                                    error: format!("HTTP/2: {e}"),
                                });
                                None
                            }
                        }
                    }
                    Some(Poll::Ready(Err(e))) => {
                        events.push(Event::Failed {
                            id,
                            error: format!("HTTP/2: {e}"),
                        });
                        None
                    }
                    _ => Some(Req::Queued(req, body)),
                },
                Req::Waiting(mut f) => match Pin::new(&mut f).poll(&mut cx) {
                    Poll::Ready(Ok(resp)) => {
                        events.push(Event::Status {
                            id,
                            status: resp.status().as_u16(),
                        });
                        Some(Req::Body(resp.into_body()))
                    }
                    Poll::Ready(Err(e)) => {
                        events.push(Event::Failed {
                            id,
                            error: format!("HTTP/2: {e}"),
                        });
                        None
                    }
                    Poll::Pending => Some(Req::Waiting(f)),
                },
                Req::Body(mut body) => {
                    let mut done = false;
                    loop {
                        match body.poll_data(&mut cx) {
                            Poll::Ready(Some(Ok(data))) => {
                                // Give the window back as soon as it's read: the map stream is endless.
                                let _ = body.flow_control().release_capacity(data.len());
                                events.push(Event::Data {
                                    id,
                                    data: data.to_vec(),
                                });
                            }
                            Poll::Ready(Some(Err(e))) => {
                                events.push(Event::Failed {
                                    id,
                                    error: format!("HTTP/2: {e}"),
                                });
                                done = true;
                                break;
                            }
                            Poll::Ready(None) => {
                                events.push(Event::End { id });
                                done = true;
                                break;
                            }
                            Poll::Pending => break,
                        }
                    }
                    (!done).then_some(Req::Body(body))
                }
            };
            if let Some(n) = next {
                self.reqs.insert(id, n);
            }
        }
        moved
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    type ServerHandshake =
        Pin<Box<dyn Future<Output = Result<h2::server::Connection<Pipe, Bytes>, h2::Error>>>>;

    /// A minimal HTTP/2 server from h2 itself, over a second pipe, for the client to talk to.
    struct Server {
        buf: Rc<RefCell<Buffers>>,
        hs: Option<ServerHandshake>,
        conn: Option<h2::server::Connection<Pipe, Bytes>>,
        /// Responses to send: the body, in pieces, and whether to end it.
        streams: Vec<(Vec<u8>, h2::server::SendResponse<Bytes>, RecvStream)>,
    }

    impl Server {
        fn new() -> Self {
            let buf = Rc::new(RefCell::new(Buffers::default()));
            Server {
                hs: Some(Box::pin(h2::server::handshake(Pipe(buf.clone())))),
                buf,
                conn: None,
                streams: Vec::new(),
            }
        }

        /// Runs the server on `input`; what it wrote.
        fn run(&mut self, input: &[u8]) -> Vec<u8> {
            let mut cx = Context::from_waker(Waker::noop());
            self.buf.borrow_mut().input.extend(input);
            for _ in 0..8 {
                if let Some(h) = self.hs.as_mut()
                    && let Poll::Ready(r) = h.as_mut().poll(&mut cx)
                {
                    self.conn = Some(r.unwrap());
                    self.hs = None;
                }
                if let Some(c) = self.conn.as_mut() {
                    while let Poll::Ready(Some(Ok((req, resp)))) = c.poll_accept(&mut cx) {
                        let path = req.uri().path().as_bytes().to_vec();
                        self.streams.push((path, resp, req.into_body()));
                    }
                    let _ = c.poll_closed(&mut cx);
                }
                for (path, _, body) in self.streams.iter_mut() {
                    while let Poll::Ready(Some(Ok(d))) = body.poll_data(&mut cx) {
                        let _ = body.flow_control().release_capacity(d.len());
                        path.extend_from_slice(b"|");
                        path.extend_from_slice(&d);
                    }
                }
            }
            std::mem::take(&mut self.buf.borrow_mut().output)
        }
    }

    #[test]
    fn a_post_and_a_streamed_response_larger_than_the_window() {
        let mut c = Client::new("https://control.test");
        let mut s = Server::new();
        let id = c.post(
            "/machine/map",
            &[("ts-lb", "x")],
            b"{\"Stream\":true}".to_vec(),
        );
        let mut events = Vec::new();
        let shuttle = |c: &mut Client, s: &mut Server, events: &mut Vec<Event>| {
            for _ in 0..20 {
                events.extend(c.poll());
                let out = s.run(&c.take_output());
                c.input(&out);
            }
            events.extend(c.poll());
        };
        shuttle(&mut c, &mut s, &mut events);
        assert_eq!(s.streams.len(), 1);
        assert_eq!(s.streams[0].0, b"/machine/map|{\"Stream\":true}");
        let (_, resp, _) = &mut s.streams[0];
        let mut send = resp
            .send_response(
                http::Response::builder().status(200).body(()).unwrap(),
                false,
            )
            .unwrap();
        // 300 KB: well over the initial 64 KB window, so it flows only if the client gives it back.
        let big = vec![7u8; 300_000];
        for chunk in big.chunks(16_000) {
            send.reserve_capacity(chunk.len());
            send.send_data(Bytes::copy_from_slice(chunk), false)
                .unwrap();
        }
        send.send_data(Bytes::new(), true).unwrap();
        shuttle(&mut c, &mut s, &mut events);
        for _ in 0..40 {
            shuttle(&mut c, &mut s, &mut events);
        }
        assert_eq!(events[0], Event::Status { id, status: 200 });
        let got: usize = events
            .iter()
            .map(|e| match e {
                Event::Data { data, .. } => data.len(),
                _ => 0,
            })
            .sum();
        assert_eq!(got, big.len());
        assert_eq!(events.last(), Some(&Event::End { id }));
    }
}
