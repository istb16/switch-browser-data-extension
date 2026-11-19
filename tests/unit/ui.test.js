import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { $, escHtml, showStatus, notify, reportError } from '../../lib/ui.js';
import { MESSAGES } from '../../lib/i18n.js';

describe('lib/ui', () => {
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

  describe('notify / reportError', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      document.body.innerHTML = '<div id="statusMsg" class="status-msg hidden"></div>';
    });
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('notify shows the translated message on #statusMsg, success by default', () => {
      notify('status_saved', { name: 'A' });
      const el = $('statusMsg');
      expect(el.textContent).toBe(MESSAGES.ja.status_saved.replace('{name}', 'A'));
      expect(el.className).toBe('status-msg success');

      notify('error_enter_name', {}, 'error');
      expect(el.textContent).toBe(MESSAGES.ja.error_enter_name);
      expect(el.className).toBe('status-msg error');
    });

    it('reportError shows the message as an error and logs the error', () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const error = new Error('boom');
      reportError('error_save_failed', error);
      const el = $('statusMsg');
      expect(el.textContent).toBe(MESSAGES.ja.error_save_failed);
      expect(el.className).toBe('status-msg error');
      expect(log).toHaveBeenCalledWith(error);
    });
  });
});
