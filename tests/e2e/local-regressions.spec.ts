import { test, expect, openTool, completed, downloadText, syntheticJwt } from '../fixtures/integration/browser';
import { subnetStateSchema, type LocalToolId } from '@domos/contracts';
import type { Locator } from '@playwright/test';

async function expectUnobscuredAllocationText(cell: Locator) {
  await expect.poll(() => cell.evaluate((element) => {
    const region = element.closest('.allocation-table');
    if (!(region instanceof HTMLElement)) throw new Error('Expected allocation scroll region');
    const viewport = region.getBoundingClientRect();
    const left = Math.max(0, viewport.left + region.clientLeft);
    const right = Math.min(innerWidth, viewport.left + region.clientLeft + region.clientWidth);
    const top = Math.max(0, viewport.top + region.clientTop);
    const bottom = Math.min(innerHeight, viewport.top + region.clientTop + region.clientHeight);
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const obscured: string[] = [];
    const wrapped: string[] = [];
    let words = 0;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      for (const match of (node.textContent ?? '').matchAll(/\S+/g)) {
        words++;
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        if (range.getClientRects().length !== 1) wrapped.push(match[0]);
        // Check every glyph, not just the cell box: sticky siblings can cover
        // real text while Playwright still considers the cell visible.
        for (let offset = match.index; offset < match.index + match[0].length; offset++) {
          range.setStart(node, offset);
          range.setEnd(node, offset + 1);
          const rect = range.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          if (!rect.width || !rect.height || rect.left < left - 1 || rect.right > right + 1
            || rect.top < top - 1 || rect.bottom > bottom + 1 || !hit || !element.contains(hit)) {
            obscured.push(node.textContent?.[offset] ?? '');
          }
        }
      }
    }
    return { hasText: words > 0, obscured, wrapped };
  }), 'Every allocation value/note glyph must fit the scroll viewport and pass hit testing, without broken words')
    .toEqual({ hasText: true, obscured: [], wrapped: [] });
}

test('JSON preserves a large integer through formatting, validation and YAML round-trip', async ({ page }) => {
  await openTool(page, 'json-yaml-workbench');
  const document = '{"id":900719925474099312345,"label":"QA_SENTINEL"}';
  await page.getByLabel('JSON or YAML input').fill(document);
  await page.getByRole('button', { name: 'Transform document' }).click();
  await completed(page);
  await expect(page.locator('.result-text')).toContainText('900719925474099312345');
  await page.getByLabel('Action').selectOption('validate');
  await page.getByRole('button', { name: 'Validate document' }).click();
  await completed(page);
  await expect(page.getByText('The document passed validation. No transformed text was requested.')).toBeVisible();
  await page.getByLabel('Action').selectOption('convert');
  await page.getByRole('button', { name: 'Transform document' }).click();
  await completed(page);
  const yaml = await page.locator('.result-text').innerText();
  expect(yaml).toContain('900719925474099312345');
  await page.getByLabel('JSON or YAML input').fill(yaml);
  await page.getByLabel('Input format').selectOption('yaml');
  await page.getByLabel('Convert to').selectOption('json');
  await page.getByRole('button', { name: 'Transform document' }).click();
  await completed(page);
  await expect(page.locator('.result-text')).toContainText('"id": 900719925474099312345');
});

test('Base64 unicode round-trip, explicit clipboard success and exact download bytes', async ({ page, context }) => {
  await openTool(page, 'base64');
  const text = 'QA \u00e9 \u4e16\u754c \ud83d\ude80';
  const encoded = Buffer.from(text).toString('base64');
  await page.getByLabel('Text or hexadecimal bytes').fill(text);
  await page.getByRole('button', { name: 'Encode bytes' }).click();
  await completed(page);
  await expect(page.locator('.result-text')).toHaveText(encoded);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: 'Copy result', exact: true }).click();
  await expect(page.getByText('Copied to clipboard.')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(encoded);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  expect(await downloadText(await pending)).toBe(encoded);
  await page.getByLabel('Operation').selectOption('decode');
  await page.getByLabel('Base64 input').fill(encoded);
  await page.getByRole('button', { name: 'Decode Base64' }).click();
  await completed(page);
  await expect(page.locator('.result-text')).toHaveText(text);
});

test('subnet annotation JSON round-trip and CSV export retain selected allocation semantics', async ({ page }) => {
  await openTool(page, 'ipv4-subnet-planner');
  await page.getByLabel('Base IPv4 CIDR').fill('192.0.2.0/31');
  await page.getByRole('button', { name: 'Create / replace plan' }).click();
  await completed(page);
  const select = page.getByRole('checkbox', { name: 'Select 192.0.2.0/31', exact: true });
  await select.focus();
  await page.keyboard.press('Space');
  await expect(select).toBeChecked();
  await expect(page.locator('.pairs')).toContainText('/31 point-to-point: both addresses usable');
  await page.getByRole('button', { name: 'Split selected block' }).click();
  await page.getByRole('checkbox', { name: 'Select 192.0.2.0/32', exact: true }).check();
  await expect(page.locator('.pairs')).toContainText('/32 host route: one address');
  await expect(page.getByRole('button', { name: 'Split selected block' })).toBeDisabled();
  const note = 'QA, "quoted" subnet';
  await page.getByLabel('Allocation note').fill(note);
  await page.getByLabel('Allocation color').selectOption('violet');
  await page.getByRole('button', { name: 'Save note and color' }).click();
  await expect(page.getByRole('cell').filter({ hasText: note })).toBeVisible();
  await page.getByRole('button', { name: 'Prepare JSON export' }).click();
  let pending = page.waitForEvent('download');
  await page.getByRole('button', { name: /^Download .*\.json$/ }).click();
  const json = await downloadText(await pending);
  const plan = subnetStateSchema.parse(JSON.parse(json));
  expect(plan.allocations).toContainEqual({ cidr: '192.0.2.0/32', note, color: 'violet' });
  await page.getByRole('button', { name: 'Prepare CSV export' }).click();
  pending = page.waitForEvent('download');
  await page.getByRole('button', { name: /^Download .*\.csv$/ }).click();
  const csv = await downloadText(await pending);
  expect(csv).toContain('"QA, ""quoted"" subnet"');
  expect(csv).toContain('192.0.2.0/32');
  await page.getByRole('button', { name: 'Clear / reset' }).click();
  await page.getByLabel('Subnet plan JSON').fill(json);
  await page.getByRole('button', { name: 'Import JSON plan' }).click();
  await completed(page);
  await expect(page.getByRole('cell').filter({ hasText: note })).toBeVisible();
  await page.getByLabel('Subnet plan JSON').fill('{"version":1}');
  await page.getByRole('button', { name: 'Import JSON plan' }).click();
  await expect(page.getByRole('alert')).toContainText('INVALID_INPUT');
  await expect(page.getByRole('checkbox', { name: 'Select 192.0.2.1/32', exact: true })).toBeVisible();
});

test('subnet allocation rows keep values and saved notes unobscured with keyboard scrolling and selection', async ({ page }) => {
  await openTool(page, 'ipv4-subnet-planner');
  await page.getByLabel('Base IPv4 CIDR').fill('10.42.0.0/16');
  await page.getByRole('button', { name: 'Create / replace plan' }).click();
  await completed(page);
  const region = page.getByRole('region', { name: 'Keyboard allocation table / page 1', exact: true });
  const checkbox = region.getByRole('checkbox', { name: 'Select 10.42.0.0/16', exact: true });
  expect(await checkbox.locator('..').evaluate((label) => label.getBoundingClientRect().height)).toBeLessThanOrEqual(52);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  if (page.viewportSize()!.width <= 768) {
    expect(await region.evaluate((element) => element.scrollWidth)).toBeGreaterThan(await region.evaluate((element) => element.clientWidth));
    await region.focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => region.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  }
  await checkbox.focus();
  await page.keyboard.press('Space');
  await expect(checkbox).toBeChecked();
  await expect(page.getByRole('button', { name: 'Split selected block' })).toBeEnabled();
  await page.getByRole('button', { name: 'Split selected block' }).click();
  const first = page.getByRole('checkbox', { name: 'Select 10.42.0.0/17', exact: true });
  const second = page.getByRole('checkbox', { name: 'Select 10.42.128.0/17', exact: true });
  await first.focus();
  await page.keyboard.press('Space');
  await expect(first).toBeChecked();
  const note = 'QA sample allocation note';
  await page.getByLabel('Allocation note').fill(note);
  await page.getByLabel('Allocation color').selectOption('violet');
  await page.getByRole('button', { name: 'Save note and color' }).click();
  const row = region.getByRole('row').filter({ has: first });
  const noteCell = row.getByRole('cell').last();
  await expect(noteCell).toHaveText(`violet ${note}`);
  const expectedValues = [
    ['10.42.0.0/17', '10.42.0.1', '10.42.127.254', '32768 / 32766', 'subnet'],
    ['10.42.128.0/17', '10.42.128.1', '10.42.255.254', '32768 / 32766', 'subnet'],
  ];
  for (const [index, allocation] of [first, second].entries()) {
    const cells = region.getByRole('row').filter({ has: allocation }).getByRole('cell');
    const values = expectedValues[index]!;
    await expect(cells.nth(1)).toHaveText(values[0]!);
    await expect(cells.nth(2)).toContainText(values[1]!);
    await expect(cells.nth(2)).toContainText(values[2]!);
    await expect(cells.nth(3)).toHaveText(values[3]!);
    await expect(cells.nth(4)).toHaveText(values[4]!);
    for (const column of [1, 2, 3, 4]) {
      const cell = cells.nth(column);
      await cell.scrollIntoViewIfNeeded();
      await expectUnobscuredAllocationText(cell);
    }
  }
  await region.scrollIntoViewIfNeeded();
  await region.focus();
  await region.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  await expect.poll(() => region.evaluate((element) => Math.abs(element.scrollWidth - element.clientWidth - element.scrollLeft))).toBeLessThanOrEqual(1);
  await expectUnobscuredAllocationText(noteCell);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  if (page.viewportSize()!.width <= 768) {
    const end = await region.evaluate((element) => element.scrollLeft);
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => region.evaluate((element) => element.scrollLeft)).toBeLessThan(end);
  }
  // Return from the far columns using only Tab and Space, not pointer clicks.
  await page.keyboard.press('Tab');
  await expect(first).toBeFocused();
  await expectUnobscuredAllocationText(first.locator('..'));
  await page.keyboard.press('Space');
  await expect(first).not.toBeChecked();
  await page.keyboard.press('Tab');
  await expect(second).toBeFocused();
  await expectUnobscuredAllocationText(second.locator('..'));
  await page.keyboard.press('Space');
  await expect(second).toBeChecked();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Space');
  await expect(first).toBeChecked();
  await expect(page.getByRole('button', { name: 'Join selected siblings' })).toBeEnabled();
});

test('JWT timestamp claims are relative to the supplied reference and stay unverified', async ({ page }) => {
  await openTool(page, 'jwt-decoder');
  await page.getByLabel('JWT token').fill(syntheticJwt({ sub: 'QA_ONLY', exp: 1704067200 }));
  await page.getByLabel('Reference time').fill('2024-01-02T00:00:00Z');
  await page.getByRole('button', { name: 'Decode unverified token' }).click();
  await completed(page);
  const claim = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'exp', exact: true }) });
  await expect(claim).toContainText('1704067200');
  await expect(claim).toContainText('2024-01-01T00:00:00.000Z');
  await expect(page.getByRole('cell', { name: 'past', exact: true })).toBeVisible();
  await expect(page.getByText('UNVERIFIED / signature not checked')).toBeVisible();
});

test('file checksum progress can be cancelled and a fresh worker can finish afterwards', async ({ page }) => {
  await openTool(page, 'sha-checksums');
  await page.getByLabel('Hash source').selectOption('file');
  // Create a synthetic Blob inside the page: no fixture file, user data or upload.
  await page.getByLabel('Local file').evaluate((input) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(32 * 1024 * 1024)], 'qa-zeroes.bin'));
    if (!(input instanceof HTMLInputElement)) throw new Error('Expected file input');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.getByRole('button', { name: 'Calculate checksums' }).click();
  await expect(page.getByRole('progressbar')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByText('Cancelled. No result retained for this run.', { exact: true })).toBeVisible();
  await expect(page.locator('.result-text')).toHaveCount(0);
  await page.getByLabel('Local file').setInputFiles({ name: 'abc.txt', mimeType: 'text/plain', buffer: Buffer.from('abc') });
  await page.getByRole('button', { name: 'Calculate checksums' }).click();
  await expect(page.getByText('File hashing complete.', { exact: true })).toBeVisible();
  await expect(page.locator('.result-text')).toHaveText('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  await expect(page.getByRole('progressbar')).toHaveAttribute('value', '3');
});

test('catastrophic regex does not block keyboard/theme events and next worker succeeds', async ({ page }) => {
  await openTool(page, 'regex-tester');
  await page.getByLabel('Regex pattern').fill('(a+)+$');
  await page.getByLabel('Test input').fill('a'.repeat(5000) + '!');
  await page.getByRole('button', { name: 'Test expression' }).click();
  await page.getByRole('button', { name: 'Switch to dark mode' }).click({ timeout: 800 });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark', { timeout: 800 });
  await expect(page.getByRole('alert')).toContainText('TIMEOUT');
  await page.getByLabel('Regex pattern').fill('QA\\d+');
  await page.getByLabel('Test input').fill('QA42');
  await page.getByRole('button', { name: 'Test expression' }).click();
  await completed(page);
  await expect(page.getByRole('cell', { name: 'QA42', exact: true })).toBeVisible();
});

test('cron explicit timezone and reference yield known UTC instants', async ({ page }) => {
  await openTool(page, 'cron-helper');
  await page.getByLabel('Cron expression').fill('0 9 * * MON-FRI');
  await page.getByLabel('IANA timezone').fill('America/New_York');
  await page.getByLabel('Reference time').fill('2026-01-01T00:00:00Z');
  await page.getByRole('button', { name: 'Show next 10 runs' }).click();
  await completed(page);
  await expect(page.locator('tbody tr').first()).toContainText('2026-01-01T14:00:00.000Z');
  await expect(page.locator('tbody tr').first()).toContainText('-300');
});

test('epoch milliseconds and ISO round-trip do not guess units', async ({ page }) => {
  await openTool(page, 'epoch-time');
  await page.getByLabel('Epoch value').fill('1704067200123');
  await page.getByLabel('Epoch unit').selectOption('milliseconds');
  await page.getByRole('button', { name: 'Convert time' }).click();
  await completed(page);
  await expect(page.locator('.pairs')).toContainText('2024-01-01T00:00:00.123Z');
  await page.getByLabel('Conversion direction').selectOption('from-iso');
  await page.getByLabel('ISO timestamp').fill('2024-01-01T00:00:00.123Z');
  await page.getByRole('button', { name: 'Convert time' }).click();
  await completed(page);
  await expect(page.locator('.pairs')).toContainText('1704067200123');
  await expect(page.locator('.pairs')).toContainText('1704067200.123');
});

test('chmod checkboxes agree with a safe command preview', async ({ page }) => {
  await openTool(page, 'chmod');
  await page.getByLabel('Permission input').selectOption('from-bits');
  await page.getByLabel('owner Execute').check();
  await page.getByLabel('group Execute').check();
  await page.getByLabel('other Execute').check();
  await page.getByRole('button', { name: 'Calculate permissions' }).click();
  await completed(page);
  await expect(page.locator('.pairs')).toContainText('0755');
  await expect(page.locator('.pairs')).toContainText('rwxr-xr-x');
  await expect(page.locator('.result-text')).toContainText('chmod 0755');
});

test('password options and passphrase entropy labels match generated shapes', async ({ page }) => {
  await openTool(page, 'password-generator');
  for (const name of ['Uppercase A-Z', 'Lowercase a-z', 'Symbols']) await page.getByLabel(name, { exact: true }).uncheck();
  await page.getByLabel('Password length').fill('12');
  await page.getByLabel('Number to generate').fill('3');
  await page.getByRole('button', { name: 'Generate secrets' }).click();
  await completed(page);
  await expect(page.locator('.secrets code')).toHaveCount(3);
  for (const value of await page.locator('.secrets code').allTextContents()) expect(value).toMatch(/^\d{12}$/);
  await expect(page.getByText(/Entropy:/)).toContainText('(exact)');
  await page.getByLabel('Secret type').selectOption('passphrase');
  await page.getByLabel('Word count').fill('6');
  await page.getByLabel('Number to generate').fill('1');
  await page.getByRole('button', { name: 'Generate secrets' }).click();
  await completed(page);
  await expect(page.locator('.secrets code')).toHaveText(/^[a-z]+(?:-[a-z]+){5}$/);
  await expect(page.getByText(/Entropy:/)).toContainText('66.0 bits (exact)');
  await page.getByLabel('Word separator').fill('');
  await page.getByRole('button', { name: 'Generate secrets' }).click();
  await completed(page);
  await expect(page.getByText(/Entropy:/)).toContainText('(lower-bound)');
});

const invalidCases: { id: LocalToolId; label: string; value: string; button: string; option?: [string, string]; native?: boolean }[] = [
  { id: 'ipv4-subnet-planner', label: 'Base IPv4 CIDR', value: '999.1.1.1/24', button: 'Create / replace plan' },
  { id: 'json-yaml-workbench', label: 'JSON or YAML input', value: '{"a":1,"a":2}', button: 'Transform document' },
  { id: 'base64', label: 'Base64 input', value: '%%%QA%%%', option: ['Operation', 'decode'], button: 'Decode Base64' },
  { id: 'url-workbench', label: 'Absolute URL', value: 'not a URL', button: 'Process URL' },
  { id: 'jwt-decoder', label: 'JWT token', value: 'not-a-token', button: 'Decode unverified token' },
  { id: 'sha-checksums', label: 'Text to hash', value: 'zz', option: ['Input encoding', 'hex'], button: 'Calculate checksums' },
  { id: 'regex-tester', label: 'Regex pattern', value: '[', button: 'Test expression' },
  { id: 'text-diff', label: 'Unified context lines', value: '21', button: 'Compare text', native: true },
  { id: 'cron-helper', label: 'Cron expression', value: '99 99 * * *', button: 'Show next 10 runs' },
  { id: 'epoch-time', label: 'Epoch value', value: 'tomorrow', button: 'Convert time' },
  { id: 'chmod', label: 'Octal mode', value: '999', button: 'Calculate permissions' },
  { id: 'password-generator', label: 'Password length', value: '3', button: 'Generate secrets', native: true },
  { id: 'email-header-analyzer', label: 'Email headers', value: 'not a header line', button: 'Analyze headers' },
];

for (const scenario of invalidCases) test(`${scenario.id} rejects bad input without an error-boundary false positive`, async ({ page }) => {
  await openTool(page, scenario.id);
  if (scenario.option) await page.getByLabel(scenario.option[0]).selectOption(scenario.option[1]);
  const input = page.getByLabel(scenario.label, { exact: scenario.label === 'Octal mode' });
  await input.fill(scenario.value);
  await page.getByRole('button', { name: scenario.button, exact: true }).click();
  if (scenario.native) {
    expect(await input.evaluate((element) => element instanceof HTMLInputElement && !element.validity.valid)).toBe(true);
  } else {
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('alert')).not.toContainText(/engine could not|invalid result|response rejected/i);
  }
  await expect(page.getByText('Complete. Processed in this browser.', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear / reset' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('.result-text')).toHaveCount(0);
});
