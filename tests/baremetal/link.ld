/* Bare-metal EL1 tests: loaded at the start of RAM (0x4000_0000, as on QEMU virt), entry at the first byte. */
ENTRY(_start)
SECTIONS {
  . = 0x40000000;
  .text : { KEEP(*(.text.start)) *(.text*) }
  .rodata : { *(.rodata*) }
  .data : { *(.data*) }
  .bss : { *(.bss*) *(COMMON) }
  . = ALIGN(16);
  . += 0x10000;
  stack_top = .;
  . += 0x10000;
  user_stack_top = .;
}
