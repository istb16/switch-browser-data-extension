// The default sits below 49152, outside the Windows dynamic port range: the
// previous 58173 was inside it, so an unrelated outbound connection could hold
// the port and make the test server fail to bind with EADDRINUSE.
// Override with TK3_E2E_PORT if it still collides with something local.
export const TEST_PAGE_PORT = Number(process.env.TK3_E2E_PORT) || 41973;
export const TEST_PAGE_ORIGIN = `http://localhost:${TEST_PAGE_PORT}`;
export const TEST_PAGE_URL = `${TEST_PAGE_ORIGIN}/`;
