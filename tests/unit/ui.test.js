import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { $, escHtml, showStatus } from '../../lib/ui.js';

describe('lib/ui', () => {
  it('$ looks up an element by id', () => {
    document.body.innerHTML = '<div id="target"></div>';
    expect($('target')).toBe(document.getElementById('target'));
  });

  it('escHtml escapes &, <, >, and "', () => {
    expect(escHtml('<script>alert("hi & bye")</script>')).toBe('&lt;script&gt;alert(&quot;hi &amp; bye&quot;)&lt;/script&gt;');
  });

  describe('showStatus', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('sets the message, type class, and reveals the element', () => {
      document.body.innerHTML = '<div id="statusMsg" class="status-msg hidden"></div>';
      const el = $('statusMsg');

      showStatus(el, 'saved!', 'success');

      expect(el.textContent).toBe('saved!');
      expect(el.className).toBe('status-msg success');
      expect(el.classList.contains('hidden')).toBe(false);
    });

    it('hides the element again after 3 seconds', () => {
      document.body.innerHTML = '<div id="statusMsg" class="status-msg hidden"></div>';
      const el = $('statusMsg');

      showStatus(el, 'saved!', 'success');
      expect(el.classList.contains('hidden')).toBe(false);

      vi.advanceTimersByTime(3000);
      expect(el.classList.contains('hidden')).toBe(true);
    });

    it('restarts the hide timer when called again before it fires', () => {
      document.body.innerHTML = '<div id="statusMsg" class="status-msg hidden"></div>';
      const el = $('statusMsg');

      showStatus(el, 'first', 'success');
      vi.advanceTimersByTime(2000);
      showStatus(el, 'second', 'error');
      vi.advanceTimersByTime(2000);

      expect(el.classList.contains('hidden')).toBe(false);
      expect(el.textContent).toBe('second');

      vi.advanceTimersByTime(1000);
      expect(el.classList.contains('hidden')).toBe(true);
    });
  });
});
