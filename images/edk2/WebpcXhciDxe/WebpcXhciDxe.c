/** @file
  webpc's xHCI for the firmware (docs/usb.md "The keyboard"): the machine's controller is a DT
  node, `generic-xhci`, not a PCI function. This driver finds those nodes through the DT client
  protocol and registers each as a non-discoverable xHCI device (coherent DMA, its one MMIO
  window). NonDiscoverablePciDeviceDxe then gives it a PCI I/O protocol, and EDK2's XhciDxe,
  UsbBusDxe and UsbKbDxe drive it as they do a PCI controller: the page's built-in USB keyboard
  becomes the firmware's console input.

  Copyright (c) 2026, the webpc authors. Written for webpc (images/build.sh edk2).
  SPDX-License-Identifier: MIT
**/

#include <Uefi.h>
#include <Library/BaseLib.h>
#include <Library/DebugLib.h>
#include <Library/NonDiscoverableDeviceRegistrationLib.h>
#include <Library/UefiBootServicesTableLib.h>
#include <Protocol/FdtClient.h>

EFI_STATUS
EFIAPI
WebpcXhciDxeEntryPoint (
  IN EFI_HANDLE        ImageHandle,
  IN EFI_SYSTEM_TABLE  *SystemTable
  )
{
  FDT_CLIENT_PROTOCOL  *FdtClient;
  EFI_STATUS           Status;
  EFI_STATUS           FindStatus;
  INT32                Node;
  CONST UINT64         *Reg;
  UINT32               RegSize;
  UINT64               Base;
  UINT64               Size;
  EFI_HANDLE           Handle;

  Status = gBS->LocateProtocol (&gFdtClientProtocolGuid, NULL, (VOID **)&FdtClient);
  if (EFI_ERROR (Status)) {
    return Status;
  }

  for (FindStatus = FdtClient->FindCompatibleNode (FdtClient, "generic-xhci", &Node);
       !EFI_ERROR (FindStatus);
       FindStatus = FdtClient->FindNextCompatibleNode (FdtClient, "generic-xhci", Node, &Node))
  {
    //
    // The DT's #address-cells and #size-cells are 2: one (base, size) pair of big-endian u64s.
    //
    Status = FdtClient->GetNodeProperty (FdtClient, Node, "reg", (CONST VOID **)&Reg, &RegSize);
    if (EFI_ERROR (Status) || (RegSize < 2 * sizeof (UINT64))) {
      DEBUG ((DEBUG_WARN, "%a: a generic-xhci node without a usable reg\n", __func__));
      continue;
    }

    Base   = SwapBytes64 (ReadUnaligned64 (&Reg[0]));
    Size   = SwapBytes64 (ReadUnaligned64 (&Reg[1]));
    Handle = NULL;
    Status = RegisterNonDiscoverableMmioDevice (
               NonDiscoverableDeviceTypeXhci,
               NonDiscoverableDeviceDmaTypeCoherent,
               NULL,
               &Handle,
               1,
               (UINTN)Base,
               (UINTN)Size
               );
    DEBUG ((DEBUG_INFO, "%a: xHCI at 0x%lx (0x%lx bytes): %r\n", __func__, Base, Size, Status));
  }

  return EFI_SUCCESS;
}
