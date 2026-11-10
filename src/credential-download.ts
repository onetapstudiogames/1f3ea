import { createHash } from 'node:crypto'
import { escapeHtml } from './private-browser.ts'

// The script contains no credentials. Values stay in the private page's DOM.
const CREDENTIAL_DOWNLOAD_SCRIPT = `
for (const panel of document.querySelectorAll('[data-credential-downloads]')) {
  const buttons = [...panel.querySelectorAll('[data-download]')];
  const finish = panel.querySelector('[data-finish]');
  const copied = panel.querySelector('[data-copied]');
  const saved = new Set();
  const update = () => { finish.disabled = saved.size !== buttons.length && !copied.checked; };
  for (const button of buttons) button.addEventListener('click', () => {
    const value = panel.querySelector('[data-value="' + button.dataset.download + '"]').textContent;
    const url = URL.createObjectURL(new Blob([value + '\\n'], {type: 'text/plain;charset=utf-8'}));
    const link = document.createElement('a');
    link.href = url;
    link.download = button.dataset.filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    saved.add(button);
    update();
  });
  copied.addEventListener('change', update);
  panel.querySelector('form').addEventListener('submit', event => {
    if (finish.disabled) event.preventDefault();
    else panel.querySelector('[name="merchant_key"]').value = panel.querySelector('[data-value="key"]').textContent;
  });
}
`

export const CREDENTIAL_DOWNLOAD_CSP = "'sha256-" + createHash('sha256').update(CREDENTIAL_DOWNLOAD_SCRIPT).digest('base64') + "'"

export function credentialDownloadForm(
  path: string,
  handle: string,
  merchantKey: string,
  recoveryCodes: readonly string[] | undefined,
  csrf: string,
): string {
  const files = [
    { kind: 'key', label: 'Merchant key', value: merchantKey },
    ...(recoveryCodes ? [{ kind: 'recovery-codes', label: 'Recovery codes', value: recoveryCodes.join('\n') }] : []),
  ]
  return `<style>[data-value]{white-space:pre-wrap}[data-copied]{width:auto;min-height:0}button:disabled{opacity:.5;cursor:not-allowed}</style><section data-credential-downloads><h1>${recoveryCodes ? 'Save two files' : 'Save your new key file'}</h1>
<p>${recoveryCodes ? 'Keep them in different places, then losing one does not lose both. Keep both outside chat.' : 'Save this file outside chat. Nothing has changed yet.'}</p>
${files.map(file => `<p>${file.label}: 1f3ea-${escapeHtml(handle)}-${file.kind}.txt</p><button type="button" data-download="${file.kind}" data-filename="1f3ea-${escapeHtml(handle)}-${file.kind}.txt">Download ${file.label.toLowerCase()}</button>`).join('')}
<details><summary>Download didn't work?</summary><p>Copy these into your password manager. These values are shown once.</p>
${files.map(file => `<h2>${file.label}</h2><code data-value="${file.kind}">${escapeHtml(file.value)}</code>`).join('')}
<label><input type="checkbox" data-copied> I saved ${recoveryCodes ? 'the key and all eight recovery codes separately' : 'the new key'} in my password manager</label></details>
<form method="post" action="${escapeHtml(path)}"><input type="hidden" name="action" value="confirm"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="merchant_key" value=""><button type="submit" data-finish disabled>${recoveryCodes ? 'I saved both files' : 'I saved it, replace the old key'}</button></form>
<p>Save before submitting. The next page does not contain the key.</p><noscript><p>Enable JavaScript to download and confirm. Nothing changes until you confirm.</p></noscript></section><script>${CREDENTIAL_DOWNLOAD_SCRIPT}</script>`
}
