// Copyright (c) Tailscale Inc & contributors (the engine setup follows cmd/tsconnect/wasm/wasm_js.go)
// SPDX-License-Identifier: BSD-3-Clause

// This program is webpc's Tailscale backend (docs/plans/networking.md §4): the
// Tailscale client built to wasm with a Tun device whose IP packets cross to
// JavaScript, so the packets of a guest's virtual NIC go straight into the
// engine. The engine's netstack stays for Tailscale's own services (MagicDNS
// at 100.100.100.100) but terminates none of the guest's traffic.
//
// In the worker, after wasm_exec.js, `newNode(config)` returns
// {run(callbacks), login(), logout(), setExitNode(id, done), sendPacket(u8), setPacketHandler(fn)}. The
// config: {controlURL, authKey, hostname, exitNode (a peer's stable ID from the netmap; empty or
// absent: none), ephemeral (false to keep the node across restarts, with
// stateStorage: {getState(key), setState(key, hex)})}.
package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"log"
	"net"
	"net/netip"
	"os"
	"syscall/js"
	"time"

	"github.com/tailscale/wireguard-go/tun"
	"tailscale.com/control/controlclient"
	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnauth"
	"tailscale.com/ipn/ipnlocal"
	"tailscale.com/ipn/store/mem"
	"tailscale.com/net/netns"
	"tailscale.com/net/tsaddr"
	"tailscale.com/net/tsdial"
	"tailscale.com/net/tstun"
	"tailscale.com/tailcfg"
	"tailscale.com/tsd"
	"tailscale.com/types/logid"
	"tailscale.com/wgengine"
	"tailscale.com/wgengine/netstack"
)

func main() {
	js.Global().Set("newNode", js.FuncOf(func(this js.Value, args []js.Value) any {
		if len(args) != 1 {
			log.Fatal("Usage: newNode(config)")
		}
		return newNode(args[0])
	}))
	<-make(chan bool) // keep the Go runtime alive for JS calls
}

// jsTun is the engine's Tun device: packets from the guest come in through
// sendPacket, packets for the guest go out through the JS packet handler.
type jsTun struct {
	in      chan []byte
	events  chan tun.Event
	closed  chan struct{}
	handler js.Value
}

func newJSTun() *jsTun {
	return &jsTun{in: make(chan []byte, 512), events: make(chan tun.Event), closed: make(chan struct{})}
}

func (t *jsTun) File() *os.File { panic("jsTun.File() called") }
func (t *jsTun) Close() error {
	select {
	case <-t.closed:
	default:
		close(t.closed)
		close(t.events)
	}
	return nil
}

func (t *jsTun) Read(bufs [][]byte, sizes []int, offset int) (int, error) {
	select {
	case p := <-t.in:
		sizes[0] = copy(bufs[0][offset:], p)
		return 1, nil
	case <-t.closed:
		return 0, os.ErrClosed
	}
}

func (t *jsTun) Write(bufs [][]byte, offset int) (int, error) {
	select {
	case <-t.closed:
		return 0, os.ErrClosed
	default:
	}
	for _, b := range bufs {
		p := b[offset:]
		if t.handler.IsUndefined() || t.handler.IsNull() {
			continue
		}
		u8 := js.Global().Get("Uint8Array").New(len(p))
		js.CopyBytesToJS(u8, p)
		t.handler.Invoke(u8)
	}
	return len(bufs), nil
}

func (t *jsTun) Flush() error             { return nil }
func (t *jsTun) MTU() (int, error)        { return int(tstun.DefaultTUNMTU()), nil }
func (t *jsTun) Name() (string, error)    { return "webpc0", nil }
func (t *jsTun) Events() <-chan tun.Event { return t.events }
func (t *jsTun) BatchSize() int           { return 1 }

// sendPacket queues a packet from the guest; when the queue is full it drops
// it (an IP network may).
func (t *jsTun) sendPacket(u8 js.Value) {
	p := make([]byte, u8.Length())
	js.CopyBytesToGo(p, u8)
	select {
	case t.in <- p:
	default:
	}
}

type jsStateStore struct{ s js.Value }

func (s *jsStateStore) ReadState(id ipn.StateKey) ([]byte, error) {
	v := s.s.Call("getState", string(id))
	if v.String() == "" {
		return nil, ipn.ErrStateNotExist
	}
	return hex.DecodeString(v.String())
}

func (s *jsStateStore) WriteState(id ipn.StateKey, bs []byte) error {
	s.s.Call("setState", string(id), hex.EncodeToString(bs))
	return nil
}

func str(cfg js.Value, key string) (string, bool) {
	v := cfg.Get(key)
	if v.Type() == js.TypeString {
		return v.String(), true
	}
	return "", false
}

type netMap struct {
	Name      string   `json:"name"`
	Addresses []string `json:"addresses"` // our own addresses, as the client reports them
	Peers     []peer   `json:"peers"`
	MTU       int      `json:"mtu"`
	DNS       []string `json:"dns"` // resolvers the client would use (MagicDNS is 100.100.100.100)
	Domains   []string `json:"domains"`
	ExitNode  string   `json:"exitNode"` // the stable ID of the peer in use as the exit node, or ""
}

type peer struct {
	ID        string   `json:"id"` // the stable ID, what setExitNode takes
	Name      string   `json:"name"`
	Addresses []string `json:"addresses"`
	Online    *bool    `json:"online,omitempty"`
	ExitNode  bool     `json:"exitNodeOption"`
}

func newNode(cfg js.Value) map[string]any {
	netns.SetEnabled(false)

	var store ipn.StateStore = new(mem.Store)
	if st := cfg.Get("stateStorage"); !st.IsUndefined() {
		store = &jsStateStore{st}
	}
	controlURL := ipn.DefaultControlURL
	if s, ok := str(cfg, "controlURL"); ok {
		controlURL = s
	}
	authKey, _ := str(cfg, "authKey")
	// An ephemeral node is removed by the control server once it's been away for a while: the
	// default for an auth key or when nothing is kept. A node whose state is kept (stateStorage)
	// is the same node after a reload, so it isn't ephemeral, unless the config says so.
	loginFlags := controlclient.LoginEphemeral
	if e := cfg.Get("ephemeral"); e.Type() == js.TypeBoolean && !e.Bool() {
		loginFlags = controlclient.LoginDefault
	}
	exitNode, _ := str(cfg, "exitNode")
	hostname, ok := str(cfg, "hostname")
	if !ok {
		hostname = "webpc"
	}

	// Log to the console only: the upstream client's logtail would send logs
	// to Tailscale's servers, which a headscale user doesn't want.
	logf := log.Printf

	sys := tsd.NewSystem()
	sys.Set(store)
	dialer := &tsdial.Dialer{Logf: logf}
	dialer.SetBus(sys.Bus.Get())
	jt := newJSTun()
	eng, err := wgengine.NewUserspaceEngine(logf, wgengine.Config{
		Tun:           jt,
		Dialer:        dialer,
		SetSubsystem:  sys.Set,
		ControlKnobs:  sys.ControlKnobs(),
		HealthTracker: sys.HealthTracker.Get(),
		ExtraRootCAs:  sys.ExtraRootCAs,
		Metrics:       sys.UserMetricsRegistry(),
		EventBus:      sys.Bus.Get(),
	})
	if err != nil {
		log.Fatal(err)
	}
	sys.Set(eng)

	ns, err := netstack.Create(logf, sys.Tun.Get(), eng, sys.MagicSock.Get(), dialer, sys.DNSManager.Get(), sys.ProxyMapper())
	if err != nil {
		log.Fatalf("netstack.Create: %v", err)
	}
	sys.Set(ns)
	// The guest owns its addresses and the subnets: the netstack terminates
	// neither, only Tailscale's own services.
	ns.ProcessLocalIPs = false
	ns.ProcessSubnets = false
	// The client's own connections (DNS through an exit node's DoH service, DNS upstreams)
	// are dialed in the netstack, since a browser has no OS network to dial; their replies
	// come back addressed to the node's IP, which is also the guest's: the netstack takes
	// the packets of its own connections and leaves the rest to the guest.
	ns.CheckLocalTransportEndpoints = true
	dialer.UseNetstackForIP = func(netip.Addr) bool { return true }
	dialer.NetstackDialTCP = func(ctx context.Context, dst netip.AddrPort) (net.Conn, error) {
		c, err := ns.DialContextTCP(ctx, dst) // (not returned directly: a nil *gonet.TCPConn isn't a nil net.Conn)
		if err != nil {
			return nil, err
		}
		return c, nil
	}
	dialer.NetstackDialUDP = func(ctx context.Context, dst netip.AddrPort) (net.Conn, error) {
		c, err := ns.DialContextUDP(ctx, dst)
		if err != nil {
			return nil, err
		}
		return c, nil
	}
	sys.Tun.Get().Start()

	priv, err := logid.NewPrivateID()
	if err != nil {
		log.Fatal(err)
	}
	lb, err := ipnlocal.NewLocalBackend(logf, priv.Public(), sys, loginFlags)
	if err != nil {
		log.Fatalf("ipnlocal.NewLocalBackend: %v", err)
	}
	if err := ns.Start(lb); err != nil {
		log.Fatalf("failed to start netstack: %v", err)
	}

	run := func(cb js.Value) {
		lb.SetNotifyCallback(func(n ipn.Notify) {
			if n.State != nil {
				cb.Call("notifyState", n.State.String())
			}
			if n.BrowseToURL != nil {
				cb.Call("notifyBrowseToURL", *n.BrowseToURL)
			}
			if n.SelfChange != nil || n.State != nil || n.Prefs != nil || len(n.PeersChanged) > 0 || len(n.PeersRemoved) > 0 || len(n.PeerChangedPatch) > 0 {
				if nm := lb.NetMapWithPeers(); nm != nil {
					m := netMap{Name: nm.SelfName(), MTU: int(tstun.DefaultTUNMTU()), ExitNode: string(lb.Prefs().ExitNodeID())}
					for _, p := range nm.GetAddresses().All() {
						m.Addresses = append(m.Addresses, p.String())
					}
					for _, p := range nm.Peers {
						q := peer{ID: string(p.StableID()), Name: p.Name()}
						for _, a := range p.Addresses().All() {
							q.Addresses = append(q.Addresses, a.String())
						}
						if o, ok := p.Online().GetOk(); ok {
							q.Online = &o
						}
						for _, r := range p.AllowedIPs().All() {
							if r.Bits() == 0 {
								q.ExitNode = true
							}
						}
						m.Peers = append(m.Peers, q)
					}
					// MagicDNS is answered at the service address (netstack); the
					// client's other resolvers are for the OS to use, so are ours to pass on.
					if nm.DNS.Proxied {
						m.DNS = append(m.DNS, tsaddr.TailscaleServiceIPString)
					}
					for _, r := range nm.DNS.Resolvers {
						m.DNS = append(m.DNS, r.Addr)
					}
					m.Domains = append(m.Domains, nm.DNS.Domains...)
					if b, err := json.Marshal(m); err == nil {
						cb.Call("notifyNetMap", string(b))
					}
				}
			}
		})
		go func() {
			// The defaults of a real client (ipn.NewPrefs: the tailnet's DNS settings apply, subnet routes are accepted).
			prefs := ipn.NewPrefs()
			prefs.ControlURL, prefs.WantRunning, prefs.Hostname = controlURL, true, hostname
			prefs.ExitNodeID = tailcfg.StableNodeID(exitNode)
			err := lb.Start(ipn.Options{
				UpdatePrefs: prefs,
				AuthKey:     authKey,
			})
			if err != nil {
				log.Printf("Start error: %v", err)
			}
		}()
	}

	return map[string]any{
		"run": js.FuncOf(func(this js.Value, args []js.Value) any { run(args[0]); return nil }),
		"login": js.FuncOf(func(this js.Value, args []js.Value) any {
			go lb.StartLoginInteractive(context.Background())
			return nil
		}),
		"logout": js.FuncOf(func(this js.Value, args []js.Value) any {
			go func() {
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				lb.Logout(ctx, ipnauth.Self)
			}()
			return nil
		}),
		// setExitNode(id, done) sends the guest's internet traffic through that peer (the netmap's
		// `exitNodeOption` peers), or, with "", stops; done(error) gets an error message, or "".
		"setExitNode": js.FuncOf(func(this js.Value, args []js.Value) any {
			id, done := args[0].String(), args[1]
			go func() {
				_, err := lb.EditPrefs(&ipn.MaskedPrefs{Prefs: ipn.Prefs{ExitNodeID: tailcfg.StableNodeID(id)}, ExitNodeIDSet: true})
				msg := ""
				if err != nil {
					msg = err.Error()
				}
				done.Invoke(msg)
			}()
			return nil
		}),
		"sendPacket":       js.FuncOf(func(this js.Value, args []js.Value) any { jt.sendPacket(args[0]); return nil }),
		"setPacketHandler": js.FuncOf(func(this js.Value, args []js.Value) any { jt.handler = args[0]; return nil }),
	}
}
