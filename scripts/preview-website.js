import { loadDotEnv } from "../src/config.js";
import { createDuckWebsiteServer } from "../src/web.js";

loadDotEnv();

const port = Math.max(1, Math.min(Number(process.env.DUCK_KEEP_ALIVE_PORT) || 9584, 65_535));
const client = { guilds: { cache: new Map() }, application: { owner: null } };
const server = createDuckWebsiteServer({ client });

server.listen(port, "127.0.0.1", () => {
  console.log(`Duck website preview: http://localhost:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
