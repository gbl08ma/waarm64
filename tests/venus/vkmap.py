# Host-visible Vulkan memory mapped at once (GD G8; tests/page-venus.test.ts): N memories of S MiB from the first
# host-visible type, each mapped and kept so (as VMA keeps its blocks) and written whole, then all freed. Linux gives
# each mappable blob its place in virtio-gpu's host-visible window when the blob is made, which Venus does at a memory's
# first map, so the window caps what's mapped at once: past it a map fails with VK_ERROR_OUT_OF_DEVICE_MEMORY (Godot's
# "Couldn't map buffer memory (VkResult error -2)"). Prints `vkmap mapped <k> of <n> x <s> MiB ...`.
#   python3 vkmap.py [n] [s]      (default 6 x 128 MiB)
import ctypes as C
import sys

n, s = (int(a) for a in (sys.argv[1:3] + ['6', '128'][len(sys.argv[1:3]):]))
vk = C.CDLL('libvulkan.so.1')
P, U32, U64 = C.c_void_p, C.c_uint32, C.c_uint64


class Instance(C.Structure):
    _fields_ = [('sType', U32), ('pNext', P), ('flags', U32), ('app', P), ('layers', U32), ('layerNames', P), ('exts', U32), ('extNames', P)]


class MemType(C.Structure):
    _fields_ = [('flags', U32), ('heap', U32)]


class MemHeap(C.Structure):
    _fields_ = [('size', U64), ('flags', U32)]


class MemProps(C.Structure):
    _fields_ = [('typeCount', U32), ('types', MemType * 32), ('heapCount', U32), ('heaps', MemHeap * 16)]


class Queue(C.Structure):
    _fields_ = [('sType', U32), ('pNext', P), ('flags', U32), ('family', U32), ('count', U32), ('priorities', C.POINTER(C.c_float))]


class Device(C.Structure):
    _fields_ = [('sType', U32), ('pNext', P), ('flags', U32), ('queues', U32), ('queueInfos', C.POINTER(Queue)), ('layers', U32), ('layerNames', P), ('exts', U32), ('extNames', P), ('features', P)]


class Alloc(C.Structure):
    _fields_ = [('sType', U32), ('pNext', P), ('size', U64), ('type', U32)]


def check(r, what):
    if r:
        print(f'vkmap: {what}: VkResult {r}')
        sys.exit(1)


inst = P()
check(vk.vkCreateInstance(C.byref(Instance(sType=1)), None, C.byref(inst)), 'vkCreateInstance')
count = U32(1)
phys = P()
vk.vkEnumeratePhysicalDevices(inst, C.byref(count), C.byref(phys))
props = MemProps()
vk.vkGetPhysicalDeviceMemoryProperties(phys, C.byref(props))
t = next(i for i in range(props.typeCount) if props.types[i].flags & 2)  # HOST_VISIBLE
heap = props.heaps[props.types[t].heap].size >> 20
prio = C.c_float(1)
q = Queue(sType=2, family=0, count=1, priorities=C.pointer(prio))
dev = P()
check(vk.vkCreateDevice(phys, C.byref(Device(sType=3, queues=1, queueInfos=C.pointer(q))), None, C.byref(dev)), 'vkCreateDevice')
vk.vkMapMemory.argtypes = [P, U64, U64, U64, U32, C.POINTER(P)]
vk.vkFreeMemory.argtypes = [P, U64, P]
mems, failed = [], ''
for i in range(n):
    mem = U64()
    r = vk.vkAllocateMemory(dev, C.byref(Alloc(sType=5, size=s << 20, type=t)), None, C.byref(mem))
    if r:
        failed = f'; memory {i}: vkAllocateMemory VkResult {r}'
        break
    ptr = P()
    r = vk.vkMapMemory(dev, mem.value, 0, s << 20, 0, C.byref(ptr))
    if r:
        vk.vkFreeMemory(dev, mem.value, None)
        failed = f'; memory {i}: vkMapMemory VkResult {r}'
        break
    C.memset(ptr, 0x5a, s << 20)
    mems.append(mem.value)
print(f'vkmap mapped {len(mems)} of {n} x {s} MiB (type {t}, heap {heap} MiB){failed}')
for m in mems:
    vk.vkFreeMemory(dev, m, None)
vk.vkDestroyDevice(dev, None)
vk.vkDestroyInstance(inst, None)
