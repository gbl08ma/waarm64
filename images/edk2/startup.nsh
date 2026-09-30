@echo -off
# The UEFI Shell runs this from the test disk (images/build.sh edk2: shell.img).
# It prints the test variable (absent on an erased flash bank), sets it, and
# powers off: the next boot with the same flash bytes must print it.
echo "webpc: before"
setvar WebpcTest -guid 5b5e1f2a-8c3d-4e6f-9a1b-2c3d4e5f6a7b
setvar WebpcTest -guid 5b5e1f2a-8c3d-4e6f-9a1b-2c3d4e5f6a7b -nv -bs -rt =L"persisted"
echo "webpc: done"
reset -s
