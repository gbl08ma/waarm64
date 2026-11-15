// The disk surface visualizer's job worker (docs/plans/surface.md): a disk's surface, or one of its ranges, read from
// its files (web/app/surface-job.ts) while no machine on this page runs it. A worker for the sync access handles; the
// page runs one per question and it answers once.
import { answerBuffers, type InspectAnswer } from '../surface.ts';
import { surfaceJob, type SurfaceJob } from './surface-job.ts';

self.onmessage = async (e: MessageEvent<SurfaceJob>) => {
  const answer: InspectAnswer = await surfaceJob(e.data);
  self.postMessage(answer, { transfer: answerBuffers(answer) });
};
