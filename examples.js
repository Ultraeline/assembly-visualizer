(function(root){
  const examples=[
    {id:'call',title:'看见一次函数调用',tag:'01 · 从这里开始',description:'跟随 call → 建立栈帧 → 保存局部变量 → leave → ret，观察数据如何往返。',input:'',code:`# main 调用 add_two(7, 5)，结果返回 RAX
.text
.globl main
main:
    movq $7, %rdi
    movq $5, %rsi
    call add_two
    movq %rax, %rbx
    ret

add_two:
    pushq %rbp
    movq %rsp, %rbp
    subq $16, %rsp
    movq %rdi, -8(%rbp)
    movq %rsi, -16(%rbp)
    movq -8(%rbp), %rax
    addq -16(%rbp), %rax
    leave
    ret`},
    {id:'recursive',title:'递归：叠起来的栈帧',tag:'02 · 深入栈帧',description:'计算 1 + 2 + 3 + 4。同一个函数每次进入都会产生独立的栈帧。',input:'',code:`.text
.globl main
main:
    movq $4, %rdi
    call sum
    ret

sum:
    pushq %rbp
    movq %rsp, %rbp
    subq $16, %rsp
    movq %rdi, -8(%rbp)
    cmpq $0, %rdi
    je .base
    subq $1, %rdi
    call sum
    addq -8(%rbp), %rax
    leave
    ret
.base:
    movq $0, %rax
    leave
    ret`},
    {id:'registers',title:'一个寄存器，四种宽度',tag:'03 · 数据传递',description:'对比 AL、AX、EAX 对 RAX 的影响，再看符号扩展与小端内存。',input:'',code:`.text
.globl main
main:
    movabsq $0x1122334455667788, %rax
    movb $0xaa, %al
    movw $0xbbcc, %ax
    movl $0xdeadbeef, %eax
    movq %rax, %rbx
    cltq
    pushq %rax
    movzbl (%rsp), %ecx
    popq %rdx
    ret`},
    {id:'overflow',title:'缓冲区边界之外',tag:'04 · 越界实验',description:'16 字节缓冲区，逐字节读入输入。试试 8、16、24、32 字节，观察越界如何影响返回。',input:'abcdefghijklmnopQRSTUVWX12345678',code:`# 输入可在左侧修改；getchar 是确定性的教学模型。
# 该模型仅更新 EAX，其余通用寄存器保持不变。
.text
.globl main
main:
    call read_buffer
    movq $1, %rax
    ret

read_buffer:
    pushq %rbp
    movq %rsp, %rbp
    subq $16, %rsp
# @buffer input, -16(%rbp), 16
    leaq -16(%rbp), %rdi
.read:
    call getchar
    cmpl $-1, %eax
    je .done
    movb %al, (%rdi)
    incq %rdi
    jmp .read
.done:
    leave
    ret`},
    {id:'rip',title:'地址与内存不是一回事',tag:'05 · 相对寻址',description:'lea 取得地址，mov 读取内容。带符号的 RIP 相对寻址由汇编器计算位移。',input:'',code:`.data
message:
    .asciz "你好，可视化汇编运行！"
number:
    .quad 42
.text
.globl main
main:
    leaq message(%rip), %rdi
    call puts
    leaq number(%rip), %rbx
    movq number(%rip), %rax
    movq (%rbx), %rcx
    ret`},
    {id:'disassembly',title:'粘贴反汇编也能运行',tag:'06 · 导入代码',description:'保留原始地址和机器码长度。这里的 mov 与源代码中的 movq 表示相同宽度。',input:'',code:`0000000000400100 <main>:
  400100: 55                    push   %rbp
  400101: 48 89 e5              mov    %rsp,%rbp
  400104: 48 83 ec 10           sub    $0x10,%rsp
  400108: 48 c7 45 f8 2a 00 00  movq   $0x2a,-0x8(%rbp)
  40010f: 00
  400110: 48 8b 45 f8           mov    -0x8(%rbp),%rax
  400114: c9                    leave
  400115: c3                    ret`},
    {id:'dynamic-stack',title:'动态分配的栈空间',tag:'07 · 动态栈空间',description:'sub %rax, %rsp 分配 96 字节，观察跨函数写入、分页、部分释放与回退。',input:'',code:`.text
.globl main
main:
    pushq %rbp
    movq %rsp, %rbp
    movq $96, %rax
    subq %rax, %rsp
    movq %rsp, %rdi
    call fill_space
    movq $1, %rax
    addq $32, %rsp
    leave
    ret

fill_space:
    movb $65, (%rdi)
    movb $66, 64(%rdi)
    movb $67, 95(%rdi)
    ret`}
  ];
  root.StackLensExamples=examples;if(typeof module!=='undefined')module.exports=examples;
})(typeof globalThis!=='undefined'?globalThis:this);
