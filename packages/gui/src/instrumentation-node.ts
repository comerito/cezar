// Loaded only from `instrumentation.ts`'s Node-runtime branch (see the gating +
// dynamic-import pattern there). The scheduler here is a pure `fetch`-based
// driver — no `@cezar/core` imports — so it can be safely bundled even by the
// Edge runtime, but the conditional import keeps it Node-only as a belt.

import { startInProcessScheduler } from '@/lib/scheduler/in-process-scheduler';

startInProcessScheduler();
