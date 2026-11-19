import { afterEach, describe, expect, it, vi } from 'vitest';

const { getProviderForFile } = vi.hoisted(() => ({ getProviderForFile: vi.fn() }));
vi.mock('../../src/core/ingestion/languages/index.js', () => ({ getProviderForFile }));

import { collectResolutionGroupFiles } from '../../src/core/incremental/resolution-groups.js';

afterEach(() => getProviderForFile.mockReset());

describe('incremental resolution context', () => {
  it('refreshes unchanged source files for a config-only edit, addition, or deletion', () => {
    const provider = {
      id: 'fixture',
      incrementalResolutionGroup: () => 'workspace',
      incrementalResolutionContext: (filePath: string) =>
        filePath === 'sourcemap.json' ? 'workspace' : undefined,
    };
    getProviderForFile.mockImplementation((filePath: string) =>
      filePath.endsWith('.source') ? provider : null,
    );
    const sources = ['src/main.source', 'packages/helper.source'];
    // No source changed, and a deleted config need not occur in currentFiles.
    for (const current of [sources, [...sources, 'sourcemap.json']]) {
      expect(collectResolutionGroupFiles(['sourcemap.json'], current)).toEqual(new Set(sources));
    }
    expect(collectResolutionGroupFiles(['nested/sourcemap.json'], sources)).toEqual(new Set());
  });

  it('keeps config groups provider-local while preserving changed-source dispatch', () => {
    const first = {
      id: 'first',
      incrementalResolutionGroup: () => 'workspace',
      incrementalResolutionContext: (filePath: string) =>
        filePath === 'first.config' ? 'workspace' : undefined,
    };
    const second = { id: 'second', incrementalResolutionGroup: () => 'workspace' };
    getProviderForFile.mockImplementation((filePath: string) =>
      filePath.endsWith('.first') ? first : filePath.endsWith('.second') ? second : null,
    );
    const sources = ['app.first', 'helper.first', 'app.second'];
    expect(collectResolutionGroupFiles(['first.config'], sources)).toEqual(
      new Set(['app.first', 'helper.first']),
    );
    expect(collectResolutionGroupFiles(['first.config', 'deleted.second'], sources)).toEqual(
      new Set(sources),
    );
  });

  it('includes providers from deleted source files when checking config paths', () => {
    const context = vi.fn(() => undefined);
    const provider = {
      id: 'fixture',
      incrementalResolutionGroup: () => 'workspace',
      incrementalResolutionContext: context,
    };
    getProviderForFile.mockImplementation((filePath: string) =>
      filePath.endsWith('.source') ? provider : null,
    );
    expect(collectResolutionGroupFiles(['deleted.source', 'project.config'], [])).toEqual(
      new Set(),
    );
    expect(context).toHaveBeenCalledWith('project.config');
  });

  it('does not broaden unrelated groups or inspect providers absent from the input', () => {
    const context = vi.fn(() => 'other');
    const provider = {
      id: 'fixture',
      incrementalResolutionGroup: () => 'workspace',
      incrementalResolutionContext: context,
    };
    getProviderForFile.mockImplementation((filePath: string) =>
      filePath.endsWith('.source') ? provider : null,
    );
    expect(collectResolutionGroupFiles(['project.config'], ['app.source'])).toEqual(new Set());
    context.mockClear();
    expect(collectResolutionGroupFiles(['project.config'], ['README.md'])).toEqual(new Set());
    expect(collectResolutionGroupFiles([], ['app.source'])).toEqual(new Set());
    expect(context).not.toHaveBeenCalled();
  });
});
