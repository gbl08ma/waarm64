.text
H: mov x0, #100
   bl g
   subs x5, x5, #1
   b.ne H
B: brk #0
g: stp x29, x30, [sp, #-16]!
   subs x0, x0, #1
   b.eq L
   add v0.4s, v0.4s, v0.4s
   add v1.4s, v1.4s, v1.4s
   add v2.4s, v2.4s, v2.4s
   add v3.4s, v3.4s, v3.4s
   add v4.4s, v4.4s, v4.4s
   add v5.4s, v5.4s, v5.4s
   add v6.4s, v6.4s, v6.4s
   add v7.4s, v7.4s, v7.4s
   add v8.4s, v8.4s, v8.4s
   add v9.4s, v9.4s, v9.4s
   add v10.4s, v10.4s, v10.4s
   add v11.4s, v11.4s, v11.4s
   add v12.4s, v12.4s, v12.4s
   add v13.4s, v13.4s, v13.4s
   add v14.4s, v14.4s, v14.4s
   add v15.4s, v15.4s, v15.4s
   add v16.4s, v16.4s, v16.4s
   add v17.4s, v17.4s, v17.4s
   add v18.4s, v18.4s, v18.4s
   add v19.4s, v19.4s, v19.4s
   add v20.4s, v20.4s, v20.4s
   add v21.4s, v21.4s, v21.4s
   add v22.4s, v22.4s, v22.4s
   add v23.4s, v23.4s, v23.4s
   add v24.4s, v24.4s, v24.4s
   add v25.4s, v25.4s, v25.4s
   add v26.4s, v26.4s, v26.4s
   add v27.4s, v27.4s, v27.4s
   add v28.4s, v28.4s, v28.4s
   add v29.4s, v29.4s, v29.4s
   add v30.4s, v30.4s, v30.4s
   add v31.4s, v31.4s, v31.4s
   fmadd d1, d2, d3, d4
   fadd d5, d6, d7
   bl g
   add v0.4s, v0.4s, v0.4s
   add v1.4s, v1.4s, v1.4s
   add v2.4s, v2.4s, v2.4s
   add v3.4s, v3.4s, v3.4s
   add v4.4s, v4.4s, v4.4s
   add v5.4s, v5.4s, v5.4s
   add v6.4s, v6.4s, v6.4s
   add v7.4s, v7.4s, v7.4s
   add v8.4s, v8.4s, v8.4s
   add v9.4s, v9.4s, v9.4s
   add v10.4s, v10.4s, v10.4s
   add v11.4s, v11.4s, v11.4s
   add v12.4s, v12.4s, v12.4s
   add v13.4s, v13.4s, v13.4s
   add v14.4s, v14.4s, v14.4s
   add v15.4s, v15.4s, v15.4s
   add v16.4s, v16.4s, v16.4s
   add v17.4s, v17.4s, v17.4s
   add v18.4s, v18.4s, v18.4s
   add v19.4s, v19.4s, v19.4s
   add v20.4s, v20.4s, v20.4s
   add v21.4s, v21.4s, v21.4s
   add v22.4s, v22.4s, v22.4s
   add v23.4s, v23.4s, v23.4s
   add v24.4s, v24.4s, v24.4s
   add v25.4s, v25.4s, v25.4s
   add v26.4s, v26.4s, v26.4s
   add v27.4s, v27.4s, v27.4s
   add v28.4s, v28.4s, v28.4s
   add v29.4s, v29.4s, v29.4s
   add v30.4s, v30.4s, v30.4s
   add v31.4s, v31.4s, v31.4s
   ldp x29, x30, [sp], #16
   ret
L: mov x1, #50
1: add x2, x2, #1
   subs x1, x1, #1
   b.ne 1b
   ldp x29, x30, [sp], #16
   ret
