import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// parseLibraryHtml lives in ollamaModels.ts, which imports ../config whose
// constructor requires DISCORD_TOKEN/DISCORD_CLIENT_ID. Provide dummy values
// so the module graph loads in a test context.
process.env['DISCORD_TOKEN'] ||= 'test-token';
process.env['DISCORD_CLIENT_ID'] ||= 'test-client';

const { parseLibraryHtml } = await import('../src/claude/ollamaModels.js');

// Representative snippet of ollama.com/search markup. Whenever Ollama changes
// their markup this test is the first thing that breaks — update the fixture
// (and the regexes in parseLibraryHtml) together.
const FIXTURE = `
  <ul>
    <li>
      <a href="/library/qwen2.5-coder" class="card">
        <h2>qwen2.5-coder</h2>
        <p>The latest series of Code-specific Qwen models.</p>
        <span class="chip">7b</span>
        <span class="chip">14b</span>
        <span class="chip">32b</span>
        <span class="pulls">6.3M</span>
      </a>
    </li>
    <li>
      <a href="/library/gpt-oss" class="card">
        <h2>gpt-oss</h2>
        <p>Open-weight GPT model.</p>
        <span class="chip">20b</span>
        <span class="chip">120b</span>
        <span class="pulls">2.1M</span>
      </a>
    </li>
    <li>
      <a href="/library/deepseek-v3.1" class="card">
        <h2>deepseek-v3.1</h2>
        <span class="chip">671b</span>
        <span class="pulls">480K</span>
      </a>
    </li>
  </ul>
`;

describe('parseLibraryHtml', () => {
  it('extracts model names, sizes, pulls, and descriptions', () => {
    const models = parseLibraryHtml(FIXTURE);
    assert.equal(models.length, 3);

    const coder = models.find((m) => m.name === 'qwen2.5-coder')!;
    assert.ok(coder, 'qwen2.5-coder present');
    assert.deepEqual(coder.sizes, ['7b', '14b', '32b']);
    assert.equal(coder.pulls, '6.3M');
    assert.match(coder.description || '', /Code-specific Qwen/);

    const gptoss = models.find((m) => m.name === 'gpt-oss')!;
    assert.deepEqual(gptoss.sizes, ['20b', '120b']);

    const ds = models.find((m) => m.name === 'deepseek-v3.1')!;
    assert.deepEqual(ds.sizes, ['671b']);
    assert.equal(ds.description, undefined);
  });

  it('deduplicates repeated card links', () => {
    const html = FIXTURE + FIXTURE;
    const models = parseLibraryHtml(html);
    assert.equal(models.length, 3);
  });

  it('returns an empty list when markup has no library links', () => {
    assert.deepEqual(parseLibraryHtml('<html><body>nothing</body></html>'), []);
  });
});
