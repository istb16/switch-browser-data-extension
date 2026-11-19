import { describe, it, expect } from 'vitest';
import {
  normalizeGroupDomain, validateNewGroup, groupOrigins, resolveScope, memberHosts, activeRef,
  getScopeForHost, addGroup, removeGroup,
} from '../../lib/groups.js';
import { getGroups, setGroups, getActiveSnapshots, setActiveSnapshots } from '../../lib/storage.js';

describe('lib/groups', () => {
  it('normalizeGroupDomain strips scheme, path, wildcard, dot and case', () => {
    expect(normalizeGroupDomain('https://Example.COM/path?q=1')).toBe('example.com');
    expect(normalizeGroupDomain('*.example.com')).toBe('example.com');
    expect(normalizeGroupDomain('  .Example.com ')).toBe('example.com');
    expect(normalizeGroupDomain('*://*.example.com/*')).toBe('example.com');
  });

  it('validateNewGroup rejects single-label, IP, duplicate and nested', () => {
    expect(validateNewGroup('localhost', [])).toBe('single-label');
    expect(validateNewGroup('192.168.0.1', [])).toBe('ip');
    expect(validateNewGroup('[::1]', [])).toBe('ip');
    expect(validateNewGroup('example.com', ['example.com'])).toBe('duplicate');
    expect(validateNewGroup('app.example.com', ['example.com'])).toBe('nested');
    expect(validateNewGroup('example.com', ['app.example.com'])).toBe('nested');
    expect(validateNewGroup('bad_name.com', [])).toBe('invalid');
    expect(validateNewGroup('', [])).toBe('invalid');
    expect(validateNewGroup('notexample.com', ['example.com'])).toBeNull();
  });

  it('validateNewGroup rejects co.jp, co.uk, com.au and accepts example.co.jp, example.com', () => {
    expect(validateNewGroup('co.jp', [])).toBe('registry');
    expect(validateNewGroup('co.uk', [])).toBe('registry');
    expect(validateNewGroup('com.au', [])).toBe('registry');
    expect(validateNewGroup('example.co.jp', [])).toBeNull();
    expect(validateNewGroup('example.com', [])).toBeNull();
  });

  it('validateNewGroup rejects github.io, vercel.app, pages.dev, herokuapp.com and accepts user.github.io', () => {
    for (const base of ['github.io', 'vercel.app', 'pages.dev', 'herokuapp.com']) {
      expect(validateNewGroup(base, [])).toBe('shared');
    }
    expect(validateNewGroup('user.github.io', [])).toBeNull();
  });

  it('resolveScope maps base and subdomains to the group, others to the host', () => {
    const groups = ['example.com'];
    const expected = { key: 'example.com', group: 'example.com', origins: ['*://example.com/*', '*://*.example.com/*'] };
    expect(resolveScope('example.com', groups)).toEqual({ ...expected, host: 'example.com' });
    expect(resolveScope('app.example.com', groups)).toEqual({ ...expected, host: 'app.example.com' });
    expect(resolveScope('notexample.com', groups)).toEqual({
      key: 'notexample.com', host: 'notexample.com', group: null, origins: ['*://notexample.com/*'],
    });
  });

  it('resolveScope without groups equals today\'s host keying', () => {
    expect(resolveScope('app.example.com', [])).toEqual({
      key: 'app.example.com', host: 'app.example.com', group: null, origins: ['*://app.example.com/*'],
    });
  });

  it('groupOrigins covers the base and its subdomains', () => {
    expect(groupOrigins('example.com')).toEqual(['*://example.com/*', '*://*.example.com/*']);
  });

  it('memberHosts lists the current host first, then the other member keys sorted, and no outside key', () => {
    const groups = ['example.com'];
    const keys = ['zzz.example.com', 'other.com', 'example.com', 'www.example.com', 'app.example.com', 'notexample.com'];
    const scope = resolveScope('www.example.com', groups);
    expect(memberHosts(keys, scope, groups)).toEqual(['www.example.com', 'app.example.com', 'example.com', 'zzz.example.com']);
    expect(memberHosts(['app.example.com'], scope, groups)).toEqual(['app.example.com']);
    expect(memberHosts(keys, resolveScope('other.com', groups), groups)).toEqual(['other.com']);
  });

  it('activeRef reads a string as the key\'s own snapshot and an object as is', () => {
    expect(activeRef('first', 'example.com')).toEqual({ host: 'example.com', name: 'first' });
    const ref = { host: 'app.example.com', name: 'second' };
    expect(activeRef(ref, 'example.com')).toBe(ref);
    expect(activeRef(undefined, 'example.com')).toBeNull();
  });

  it('getScopeForHost resolves through the stored groups', async () => {
    await setGroups(['example.com']);
    expect((await getScopeForHost('app.example.com')).key).toBe('example.com');
    expect((await getScopeForHost('other.com')).key).toBe('other.com');
  });

  it('addGroup stores the normalized base and refuses an invalid one', async () => {
    expect(await addGroup('https://Example.com/')).toBe('example.com');
    expect(await getGroups()).toEqual(['example.com']);
    await expect(addGroup('app.example.com')).rejects.toThrow('nested');
    expect(await getGroups()).toEqual(['example.com']);
  });

  it('removeGroup turns a base-host reference into a string and deletes any other', async () => {
    await setGroups(['example.com', 'other.org']);
    await setActiveSnapshots({
      'example.com': { host: 'example.com', name: 'first' },
      'other.org':   { host: 'app.other.org', name: 'second' },
      'plain.net':   'third',
    });

    await removeGroup('example.com');
    await removeGroup('other.org');

    expect(await getGroups()).toEqual([]);
    expect(await getActiveSnapshots()).toEqual({ 'example.com': 'first', 'plain.net': 'third' });
  });

  it('removeGroup leaves a string reference as it is', async () => {
    await setGroups(['example.com']);
    await setActiveSnapshots({ 'example.com': 'first' });
    await removeGroup('example.com');
    expect(await getActiveSnapshots()).toEqual({ 'example.com': 'first' });
  });
});
