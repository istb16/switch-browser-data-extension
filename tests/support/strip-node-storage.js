// Preloaded into each Vitest worker via poolOptions.forks.execArgv, before the
// jsdom test environment is installed.
//
// Node 26 added experimental globalThis.localStorage / sessionStorage accessors
// that are unusable unless the process was started with --localstorage-file.
// Vitest only copies a jsdom window property onto the global when the key is not
// already present (see getWindowKeys in vitest), and neither name is in its
// always-override list, so Node's unusable accessors win and bare `localStorage`
// in a test resolves to undefined. Removing them here lets jsdom's real Storage
// through.
delete globalThis.localStorage;
delete globalThis.sessionStorage;
