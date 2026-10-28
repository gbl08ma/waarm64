# VK3 L7.5: what vkd3d (WineHQ's Direct3D 12 on Vulkan, Arch's vkd3d) makes of Venus's device in the desktop guest
# (bench/vulkan/vkd3d.ts runs it): D3D12CreateDevice at each feature level through libvkd3d-utils (ctypes), with
# vkd3d's warnings (VKD3D_DEBUG=warn) on stderr: why a level is refused.
import ctypes, os, sys

class GUID(ctypes.Structure):
    _fields_ = [('d1', ctypes.c_uint32), ('d2', ctypes.c_uint16), ('d3', ctypes.c_uint16), ('d4', ctypes.c_ubyte * 8)]

IID_ID3D12Device = GUID(0x189819f1, 0x1db6, 0x4b57, (ctypes.c_ubyte * 8)(0xbe, 0x54, 0x18, 0x21, 0x33, 0x9b, 0x85, 0xf7))
lib = ctypes.CDLL('libvkd3d-utils.so.1')
lib.D3D12CreateDevice.restype = ctypes.c_int32
lib.D3D12CreateDevice.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.POINTER(GUID), ctypes.POINTER(ctypes.c_void_p)]
for name, level in (('11_0', 0xb000), ('11_1', 0xb100), ('12_0', 0xc000), ('12_1', 0xc100)):
    dev = ctypes.c_void_p()
    print(f'== feature level {name}', file=sys.stderr, flush=True)
    hr = lib.D3D12CreateDevice(None, level, ctypes.byref(IID_ID3D12Device), ctypes.byref(dev))
    print(f'level {name}: hr 0x{hr & 0xffffffff:08x}{" (device made)" if dev.value else ""}', flush=True)
    if dev.value:
        # ID3D12Device's Release, the vtable's third entry.
        vt = ctypes.cast(ctypes.cast(dev, ctypes.POINTER(ctypes.c_void_p))[0], ctypes.POINTER(ctypes.c_void_p))
        ctypes.CFUNCTYPE(ctypes.c_uint32, ctypes.c_void_p)(vt[2])(dev)
