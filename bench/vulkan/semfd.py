# VK3 L7.1b (bench/vulkan/semfd.ts): Venus in the guest and semaphores exported as opaque fds (which it doesn't offer:
# their properties say 0), each one's fd asked for twice. Not sync files: an unsignalled one's export waits forever.
import ctypes as C
vk = C.CDLL('libvulkan.so.1')
P = C.c_void_p
class AppInfo(C.Structure): _fields_ = [('sType', C.c_int), ('pNext', P), ('a', P), ('av', C.c_uint), ('e', P), ('ev', C.c_uint), ('api', C.c_uint)]
class InstInfo(C.Structure): _fields_ = [('sType', C.c_int), ('pNext', P), ('flags', C.c_uint), ('app', P), ('nl', C.c_uint), ('l', P), ('ne', C.c_uint), ('e', P)]
class QInfo(C.Structure): _fields_ = [('sType', C.c_int), ('pNext', P), ('flags', C.c_uint), ('fam', C.c_uint), ('n', C.c_uint), ('prio', P)]
class DevInfo(C.Structure): _fields_ = [('sType', C.c_int), ('pNext', P), ('flags', C.c_uint), ('nq', C.c_uint), ('q', P), ('nl', C.c_uint), ('l', P), ('ne', C.c_uint), ('e', P), ('feat', P)]
class Export(C.Structure): _fields_ = [('sType', C.c_int), ('pNext', P), ('ht', C.c_uint)]
class SemInfo(C.Structure): _fields_ = [('sType', C.c_int), ('pNext', P), ('flags', C.c_uint)]
class GetFd(C.Structure): _fields_ = [('sType', C.c_int), ('pNext', P), ('sem', C.c_uint64), ('ht', C.c_uint)]
class ExtInfo(C.Structure): _fields_ = [('sType', C.c_int), ('pNext', P), ('ht', C.c_uint)]
class ExtProps(C.Structure): _fields_ = [('sType', C.c_int), ('pNext', P), ('exp', C.c_uint), ('compat', C.c_uint), ('feat', C.c_uint)]
app = AppInfo(0, None, None, 0, None, 0, (1 << 22) | (3 << 12))
inst = P()
print('instance', vk.vkCreateInstance(C.byref(InstInfo(1, None, 0, C.addressof(app), 0, None, 0, None)), None, C.byref(inst)))
n = C.c_uint(1); pd = P()
vk.vkEnumeratePhysicalDevices(inst, C.byref(n), C.byref(pd))
for ht in (1, 16):
  props = ExtProps(1000076001, None, 0, 0, 0)
  vk.vkGetPhysicalDeviceExternalSemaphoreProperties(pd, C.byref(ExtInfo(1000076000, None, ht)), C.byref(props))
  print('external semaphore properties', ht, props.exp, props.compat, props.feat)
prio = C.c_float(1)
q = QInfo(2, None, 0, 0, 1, C.addressof(prio))
ext = (C.c_char_p * 1)(b'VK_KHR_external_semaphore_fd')
dev = P()
print('device', vk.vkCreateDevice(pd, C.byref(DevInfo(3, None, 0, 1, C.addressof(q), 0, None, 1, C.cast(ext, P), None)), None, C.byref(dev)))
gdpa = vk.vkGetDeviceProcAddr; gdpa.restype = P; gdpa.argtypes = [P, C.c_char_p]
getfd = C.CFUNCTYPE(C.c_int, P, P, P)(gdpa(dev, b'vkGetSemaphoreFdKHR'))
for k in range(2):
  ht = 1
  sem = C.c_uint64()
  ex = Export(1000077000, None, ht)
  r = vk.vkCreateSemaphore(dev, C.byref(SemInfo(9, C.addressof(ex), 0)), None, C.byref(sem))
  fds = []
  for _ in range(2):
    fd = C.c_int(-7)
    info = GetFd(1000079001, None, sem.value, ht)
    rr = getfd(dev, C.addressof(info), C.addressof(fd))
    fds.append((rr, fd.value))
  print('semaphore', k, 'exported as', ht, 'create', r, 'fds', fds)
vk.vkDeviceWaitIdle(dev)
print('done')
