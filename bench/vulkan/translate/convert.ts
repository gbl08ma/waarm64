// Arm 3's input (bench/vulkan/REPORT.md): a GFXReconstruct capture of a Vulkan program (tools/vulkan-tools/
// gfxr-capture.sh, converted with --include-binaries) turned into what our translator would receive from Venus: the
// objects the program created (setup.json) and the commands it recorded and submitted, in order, as a compact stream
// of words (stream.bin), with host-visible memory writes (GFXReconstruct's FillMemory, which it records before each
// submit) as blobs in the stream, the way the guest's writes would reach the host. The SPIR-V modules are copied out
// (shaders/<id>.spv) for the shader translation (shaders.ts). Calls a translator ignores (barriers, queries, fences,
// waits) are left out; anything else not handled stops the conversion.
//   node bench/vulkan/translate/convert.ts <capture.jsonl> <out dir> [first frame submit]
// The frames: every vkQueueSubmit from the given one on (default: the first that signals a fence) ends a frame;
// setup.json's `frameStart` is the stream's word offset where the first frame's commands begin.
import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { DESC, OP, opLength } from './stream.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const IGNORED = new Set([
  'vkCmdPipelineBarrier', 'vkCmdWriteTimestamp', 'vkCmdResetQueryPool', 'vkGetQueryPoolResults', 'vkWaitForFences', 'vkResetFences',
  'vkQueueWaitIdle', 'vkDeviceWaitIdle', 'vkResetCommandPool', 'vkAllocateCommandBuffers', 'vkFreeCommandBuffers', 'vkCreateCommandPool',
  'vkCreateFence', 'vkCreateQueryPool', 'vkGetBufferMemoryRequirements', 'vkGetImageMemoryRequirements', 'vkMapMemory', 'vkUnmapMemory',
  'vkDestroyBuffer', 'vkFreeMemory', 'vkDestroyShaderModule', 'vkEnumeratePhysicalDevices', 'vkGetPhysicalDeviceProperties',
  'vkGetPhysicalDeviceProperties2', 'vkGetPhysicalDeviceQueueFamilyProperties', 'vkGetPhysicalDeviceMemoryProperties', 'vkCreateInstance',
  'vkCreateDevice', 'vkGetDeviceQueue', 'vkCreateDescriptorPool', 'vkAllocateDescriptorSets', 'vkCmdCopyImageToBuffer',
  'vkEnumerateDeviceExtensionProperties', 'vkEnumerateInstanceExtensionProperties', 'vkGetPhysicalDeviceFeatures2',
]);

const descType = (t: string) => {
  const k = t.replace('VK_DESCRIPTOR_TYPE_', '') as keyof typeof DESC;
  if (!(k in DESC)) throw new Error(`descriptor type ${t}`);
  return DESC[k];
};

export async function convert(jsonl: string, out: string, firstFrameSubmit?: number) {
  const base = dirname(jsonl);
  mkdirSync(join(out, 'shaders'), { recursive: true });
  const words: number[] = [];
  const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
  const pushF = (x: number) => { f32[0] = x; words.push(u32[0]); };
  const blob = (b: Uint8Array) => {
    words.push(b.length);
    const padded = new Uint8Array((b.length + 3) & ~3);
    padded.set(b);
    const w = new Uint32Array(padded.buffer);
    for (const x of w) words.push(x);
  };
  const bin = (ref: unknown): Uint8Array => {
    if (typeof ref !== 'string' || ref === '[Binary data]') throw new Error(`no binary data (convert with --include-binaries): ${ref}`);
    return new Uint8Array(readFileSync(join(base, ref)));
  };
  const setup: Json = {
    memories: {}, buffers: {}, images: {}, views: {}, samplers: {}, setLayouts: {}, pipelineLayouts: {}, shaders: {}, pipelines: {},
    renderPasses: {}, framebuffers: {}, sets: {}, frameStart: 0, frames: 0, submits: 0,
  };
  let submits = 0, frameSubmit = 0, frameStart = -1;
  const unknown = new Map<string, number>();
  const rl = createInterface({ input: createReadStream(jsonl), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    const o = JSON.parse(line) as Json;
    if (o.meta) {
      if (o.meta.name === 'FillMemoryCommand') {
        const a = o.meta.args;
        words.push(OP.FILL, a.memory_id, a.offset);
        blob(bin(a.data));
      }
      continue;
    }
    const fn = o.function as Json | undefined;
    if (!fn) continue;
    const a = fn.args as Json;
    switch (fn.name) {
      case 'vkAllocateMemory': setup.memories[a.pMemory] = { size: a.pAllocateInfo.allocationSize, type: a.pAllocateInfo.memoryTypeIndex }; break;
      case 'vkCreateBuffer': setup.buffers[a.pBuffer] = { size: a.pCreateInfo.size, usage: parseInt(a.pCreateInfo.usage, 16) }; break;
      case 'vkBindBufferMemory': Object.assign(setup.buffers[a.buffer], { memory: a.memory, offset: a.memoryOffset }); break;
      case 'vkCreateImage': {
        const c = a.pCreateInfo;
        setup.images[a.pImage] = { format: c.format, width: c.extent.width, height: c.extent.height, mips: c.mipLevels, layers: c.arrayLayers,
          samples: parseInt(String(c.samples).replace(/\D/g, ''), 10), usage: parseInt(c.usage, 16), flags: parseInt(c.flags, 16) };
        break;
      }
      case 'vkBindImageMemory': Object.assign(setup.images[a.image], { memory: a.memory }); break;
      case 'vkCreateImageView': {
        const c = a.pCreateInfo;
        setup.views[a.pView] = { image: c.image, viewType: c.viewType, format: c.format, baseMip: c.subresourceRange.baseMipLevel,
          mips: c.subresourceRange.levelCount, baseLayer: c.subresourceRange.baseArrayLayer, layers: c.subresourceRange.layerCount };
        break;
      }
      case 'vkCreateSampler': {
        const c = a.pCreateInfo;
        setup.samplers[a.pSampler] = { magFilter: c.magFilter, minFilter: c.minFilter, mipmapMode: c.mipmapMode,
          addressModeU: c.addressModeU, addressModeV: c.addressModeV, addressModeW: c.addressModeW, minLod: c.minLod, maxLod: c.maxLod };
        break;
      }
      case 'vkCreateDescriptorSetLayout':
        setup.setLayouts[a.pSetLayout] = (a.pCreateInfo.pBindings as Json[]).map((b) => ({ binding: b.binding, type: descType(b.descriptorType),
          count: b.descriptorCount, stages: parseInt(b.stageFlags, 16) }));
        break;
      case 'vkCreatePipelineLayout':
        setup.pipelineLayouts[a.pPipelineLayout] = { setLayouts: a.pCreateInfo.pSetLayouts ?? [],
          push: ((a.pCreateInfo.pPushConstantRanges ?? []) as Json[]).map((r) => ({ stages: parseInt(r.stageFlags, 16), offset: r.offset, size: r.size })) };
        break;
      case 'vkCreateShaderModule':
        {
          const code = bin(a.pCreateInfo.pCode);
          writeFileSync(join(out, 'shaders', `${a.pShaderModule}.spv`), code);
          // The module's content names its translation (shaders.ts), whatever handle a capture gave it.
          setup.shaders[a.pShaderModule] = { spv: `shaders/${a.pShaderModule}.spv`, hash: createHash('sha256').update(code).digest('hex').slice(0, 16) };
        }
        break;
      case 'vkCreateGraphicsPipelines':
        (a.pCreateInfos as Json[]).forEach((c, i) => { setup.pipelines[a.pPipelines[i]] = graphicsPipeline(c, bin); });
        break;
      case 'vkCreateRenderPass': setup.renderPasses[a.pRenderPass] = renderPass(a.pCreateInfo); break;
      case 'vkCreateFramebuffer': setup.framebuffers[a.pFramebuffer] = { renderPass: a.pCreateInfo.renderPass, attachments: a.pCreateInfo.pAttachments, width: a.pCreateInfo.width, height: a.pCreateInfo.height }; break;
      case 'vkAllocateDescriptorSets': (a.pDescriptorSets as number[]).forEach((s, i) => { setup.sets[s] = { layout: a.pAllocateInfo.pSetLayouts[i] }; }); break;
      case 'vkUpdateDescriptorSets': {
        const writes = (a.pDescriptorWrites ?? []) as Json[];
        words.push(OP.UPDATE_DESC, writes.length);
        for (const w of writes) {
          const t = descType(w.descriptorType);
          words.push(w.dstSet, w.dstBinding, w.dstArrayElement, t, w.descriptorCount);
          for (let k = 0; k < w.descriptorCount; k++) {
            if (t === DESC.COMBINED_IMAGE_SAMPLER || t === DESC.SAMPLED_IMAGE || t === DESC.SAMPLER) {
              const ii = w.pImageInfo[k];
              words.push(ii.sampler ?? 0, ii.imageView ?? 0);
            } else {
              const bi = w.pBufferInfo[k];
              words.push(bi.buffer, bi.offset, bi.range === 'VK_WHOLE_SIZE' ? 0xffffffff : bi.range);
            }
          }
        }
        if (a.descriptorCopyCount) throw new Error('descriptor copies');
        break;
      }
      case 'vkBeginCommandBuffer': words.push(OP.BEGIN_CB, a.commandBuffer); break;
      case 'vkEndCommandBuffer': words.push(OP.END_CB, a.commandBuffer); break;
      case 'vkCmdBeginRenderPass': {
        const b = a.pRenderPassBegin;
        words.push(OP.BEGIN_RP, b.renderPass, b.framebuffer, b.renderArea.offset.x, b.renderArea.offset.y, b.renderArea.extent.width, b.renderArea.extent.height, b.clearValueCount);
        for (const cv of b.pClearValues as Json[]) {
          // A clear value is a union: the colour's floats and the depth both kept, the render pass picks.
          for (const x of cv.color.float32) pushF(x);
          pushF(cv.depthStencil.depth);
        }
        break;
      }
      case 'vkCmdEndRenderPass': words.push(OP.END_RP); break;
      case 'vkCmdSetViewport': {
        const v = a.pViewports[0];
        words.push(OP.VIEWPORT);
        for (const x of [v.x, v.y, v.width, v.height, v.minDepth, v.maxDepth]) pushF(x);
        break;
      }
      case 'vkCmdSetScissor': { const s = a.pScissors[0]; words.push(OP.SCISSOR, s.offset.x, s.offset.y, s.extent.width, s.extent.height); break; }
      case 'vkCmdBindPipeline': words.push(OP.BIND_PIPELINE, a.pipeline); break;
      case 'vkCmdBindDescriptorSets':
        words.push(OP.BIND_SETS, a.layout, a.firstSet, a.descriptorSetCount, ...(a.pDescriptorSets as number[]), a.dynamicOffsetCount, ...((a.pDynamicOffsets ?? []) as number[]));
        break;
      case 'vkCmdPushConstants': words.push(OP.PUSH, a.layout, parseInt(a.stageFlags, 16), a.offset); blob(bin(a.pValues)); break;
      case 'vkCmdBindVertexBuffers':
        words.push(OP.BIND_VB, a.firstBinding, a.bindingCount);
        (a.pBuffers as number[]).forEach((b, i) => words.push(b, a.pOffsets[i]));
        break;
      case 'vkCmdBindIndexBuffer': words.push(OP.BIND_IB, a.buffer, a.offset, a.indexType === 'VK_INDEX_TYPE_UINT32' ? 32 : 16); break;
      case 'vkCmdDraw': words.push(OP.DRAW, a.vertexCount, a.instanceCount, a.firstVertex, a.firstInstance); break;
      case 'vkCmdDrawIndexed': words.push(OP.DRAW_INDEXED, a.indexCount, a.instanceCount, a.firstIndex, a.vertexOffset >>> 0, a.firstInstance); break;
      case 'vkCmdCopyBuffer':
        words.push(OP.COPY_BUFFER, a.srcBuffer, a.dstBuffer, a.regionCount);
        for (const r of a.pRegions as Json[]) words.push(r.srcOffset, r.dstOffset, r.size);
        break;
      case 'vkCmdCopyBufferToImage':
        words.push(OP.COPY_BUF_TO_IMG, a.srcBuffer, a.dstImage, a.regionCount);
        for (const r of a.pRegions as Json[]) {
          words.push(r.bufferOffset, r.bufferRowLength, r.bufferImageHeight, r.imageSubresource.mipLevel, r.imageSubresource.baseArrayLayer,
            r.imageSubresource.layerCount, r.imageOffset.x, r.imageOffset.y, r.imageExtent.width, r.imageExtent.height);
        }
        break;
      case 'vkQueueSubmit': {
        const cbs = (a.pSubmits as Json[]).flatMap((s) => s.pCommandBuffers as number[]);
        // The frames start at the given submit, or at the first that signals a fence (a frame paced by its fence; the
        // setup's submits wait for the queue instead).
        if (frameStart < 0 && (firstFrameSubmit !== undefined ? submits === firstFrameSubmit : a.fence !== 0)) { frameStart = words.length; frameSubmit = submits; }
        words.push(OP.SUBMIT, cbs.length, ...cbs);
        submits++;
        break;
      }
      default:
        if (!IGNORED.has(fn.name)) unknown.set(fn.name, (unknown.get(fn.name) ?? 0) + 1);
    }
  }
  if (unknown.size) throw new Error(`calls the converter doesn't handle: ${[...unknown].map(([k, n]) => `${k} x${n}`).join(', ')}`);
  if (frameStart < 0) throw new Error('no frame submits found (none signals a fence)');
  // A frame begins at its first word after the previous frame's submit (its fills, descriptor updates and recording).
  let at = 0, prevSubmitEnd = 0;
  for (let i = 0; i < words.length;) {
    const len = opLength(words, i);
    if (words[i] === OP.SUBMIT) {
      if (i === frameStart) { at = prevSubmitEnd; break; }
      prevSubmitEnd = i + len;
    }
    i += len;
  }
  setup.frameStart = at;
  setup.submits = submits;
  setup.frames = submits - frameSubmit;
  writeFileSync(join(out, 'setup.json'), JSON.stringify(setup));
  writeFileSync(join(out, 'stream.bin'), new Uint8Array(Uint32Array.from(words).buffer));
  return setup;
}

function graphicsPipeline(c: Json, bin: (r: unknown) => Uint8Array) {
  const vi = c.pVertexInputState, ia = c.pInputAssemblyState, rs = c.pRasterizationState, ms = c.pMultisampleState;
  const ds = c.pDepthStencilState, cb = c.pColorBlendState;
  return {
    layout: c.layout, renderPass: c.renderPass, subpass: c.subpass,
    stages: (c.pStages as Json[]).map((s) => {
      const sp = s.pSpecializationInfo;
      let spec: { id: number; value: number }[] = [];
      if (sp) {
        const data = Array.isArray(sp.pData) ? Uint8Array.from(sp.pData as number[]) : bin(sp.pData);
        const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
        spec = (sp.pMapEntries as Json[]).map((e) => ({ id: e.constantID, value: e.size === 4 ? dv.getUint32(e.offset, true) : dv.getUint8(e.offset) }));
      }
      return { stage: s.stage, module: s.module, entry: s.pName, spec };
    }),
    vertexBindings: ((vi?.pVertexBindingDescriptions ?? []) as Json[]).map((b) => ({ binding: b.binding, stride: b.stride, instance: b.inputRate === 'VK_VERTEX_INPUT_RATE_INSTANCE' })),
    vertexAttributes: ((vi?.pVertexAttributeDescriptions ?? []) as Json[]).map((x) => ({ location: x.location, binding: x.binding, format: x.format, offset: x.offset })),
    topology: ia.topology, cullMode: rs.cullMode, frontFace: rs.frontFace, samples: parseInt(String(ms?.rasterizationSamples ?? '1').replace(/\D/g, ''), 10) || 1,
    depthTest: !!ds?.depthTestEnable, depthWrite: !!ds?.depthWriteEnable, depthCompare: ds?.depthCompareOp,
    blend: ((cb?.pAttachments ?? []) as Json[]).map((x) => ({ enable: !!x.blendEnable, srcColor: x.srcColorBlendFactor, dstColor: x.dstColorBlendFactor, colorOp: x.colorBlendOp,
      srcAlpha: x.srcAlphaBlendFactor, dstAlpha: x.dstAlphaBlendFactor, alphaOp: x.alphaBlendOp, writeMask: parseInt(String(x.colorWriteMask), 16) })),
    dynamic: ((c.pDynamicState?.pDynamicStates ?? []) as string[]),
  };
}

function renderPass(c: Json) {
  if (c.subpassCount !== 1) throw new Error('render passes with several subpasses: not in the prototype');
  const sp = c.pSubpasses[0];
  return {
    attachments: (c.pAttachments as Json[]).map((x) => ({ format: x.format, samples: parseInt(String(x.samples).replace(/\D/g, ''), 10), load: x.loadOp, store: x.storeOp })),
    color: ((sp.pColorAttachments ?? []) as Json[]).map((x) => x.attachment),
    resolve: ((sp.pResolveAttachments ?? []) as Json[]).map((x) => x.attachment),
    depth: sp.pDepthStencilAttachment ? sp.pDepthStencilAttachment.attachment : -1,
  };
}

if (import.meta.main) {
  const [jsonl, out, first] = process.argv.slice(2);
  if (!jsonl || !out) throw new Error('usage: convert.ts <capture.jsonl> <out dir> [first frame submit]');
  const s = await convert(jsonl, out, first === undefined ? undefined : Number(first));
  console.log(`${out}: ${Object.keys(s.pipelines).length} pipelines, ${Object.keys(s.shaders).length} shaders, ${s.submits} submits, ${s.frames} frames from word ${s.frameStart}`);
}
