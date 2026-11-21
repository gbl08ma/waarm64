import sys
p=sys.argv[1]; fix=sys.argv[2]=='fix'
s=open(p).read()
def rep(a,b):
    global s
    assert s.count(a)==1, a
    s=s.replace(a,b)
rep('''    hot: Option<u32>,
    /// The transfer cache's miss functions''','''    hot: Option<u32>,
    dret: u32,
    /// The transfer cache's miss functions''')
rep('''        m.import_func("env", "jit_hot", t)
    });
''','''        m.import_func("env", "jit_hot", t)
    });
    let dret = {
        let ct = m.ty(&[I32, I64], &[]);
        m.import_func("env", "jit_diag_ret", ct)
    };
''')
rep('''            hot,
            xmiss: misses,''','''            hot,
            dret,
            xmiss: misses,''')
rep('''    emit::returned(c, len, after);
    cont(c);
''','''    emit::returned(c, len, after);
    cont(c);
    c.local_get(0);
    emit::pc_plus(c, after);
    c.call(e.dret);
''')
cond = 'offsets(&b.words).first().and_then(|&o| r.internal(i, o)).is_some()' if fix else 'offsets(&b.words).first().and_then(|&o| r.target(i, o)).filter(|&j| j > i || j == 0).is_some()'
rep('''        c.base = b.va.wrapping_sub(head) as i64;
        c.note(''','''        c.base = b.va.wrapping_sub(head) as i64;
        if b.words.last().map(|&w| decode(w)) == Some(Op::BL) && %s {
            emit::dbump(&mut c, 16);
        }
        c.note(''' % cond)
rep('''                if op == Some(Op::RET) {
                    emit::ret_up(&mut c, len);''','''                if op == Some(Op::RET) {
                    if r.returns.iter().any(|x| x.0 == b.key) {
                        c.local_get(emit::DEPTH).if_();
                        emit::dbump(&mut c, if r.returns_to(i).is_some() { 13 } else { 14 });
                        c.end();
                    }
                    emit::ret_up(&mut c, len);''')
open(p,'w').write(s)
