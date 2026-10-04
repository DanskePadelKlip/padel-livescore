// GET /world-no1 — app shell with this section's own meta (see _hubs.js for why).
import { hub } from "./_hubs.js";

export const onRequestGet = hub("world-no1");
