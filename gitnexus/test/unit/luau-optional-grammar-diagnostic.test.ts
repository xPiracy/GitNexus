import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SupportedLanguages } from 'gitnexus-shared';

const { load, skipped, warn } = vi.hoisted(() => ({
  load: vi.fn(),
  skipped: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('../../src/core/tree-sitter/vendored-grammars.js', () => ({
  requireVendoredGrammar: load,
}));
vi.mock('../../src/core/tree-sitter/parser-loader.js', () => ({
  isGrammarRuntimeSkipped: skipped,
}));
vi.mock('../../src/cli/cli-message.js', () => ({ cliWarn: warn }));

import {
  detectMissingOptionalGrammars,
  getOptionalGrammarExtensions,
  warnMissingOptionalGrammars,
} from '../../src/cli/optional-grammars.js';

beforeEach(() => {
  load.mockReset().mockReturnValue({});
  skipped.mockReset().mockReturnValue(false);
  warn.mockReset();
});

describe('Luau optional grammar diagnostics', () => {
  it('includes both Luau suffixes in analyze preflight detection', () => {
    expect(getOptionalGrammarExtensions()).toEqual(expect.arrayContaining(['.luau', '.lua']));
  });

  it.each(['.lua', '.luau'])('reports a missing native binding for %s files', (extension) => {
    load.mockImplementation((name: string) => {
      if (name === 'tree-sitter-luau') throw new Error('No native build was found');
      return {};
    });
    expect(detectMissingOptionalGrammars()).toEqual([
      { name: 'tree-sitter-luau', extensions: ['.luau', '.lua'], reason: 'missing' },
    ]);
    warnMissingOptionalGrammars({ relevantExtensions: new Set([extension]) });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('optional grammar "tree-sitter-luau" is unavailable'),
      expect.objectContaining({ grammar: 'tree-sitter-luau', reason: 'missing' }),
    );
  });

  it('distinguishes a deliberate opt-out and avoids loading the disabled binding', () => {
    skipped.mockImplementation(
      (language: SupportedLanguages) => language === SupportedLanguages.Luau,
    );
    warnMissingOptionalGrammars({ relevantExtensions: new Set(['.luau']) });
    expect(load).not.toHaveBeenCalledWith('tree-sitter-luau');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('disabled via GITNEXUS_SKIP_OPTIONAL_GRAMMARS'),
      expect.objectContaining({ grammar: 'tree-sitter-luau', reason: 'skipped' }),
    );
  });

  it('keeps Luau warnings out of repositories without Luau files', () => {
    skipped.mockImplementation(
      (language: SupportedLanguages) => language === SupportedLanguages.Luau,
    );
    warnMissingOptionalGrammars({ relevantExtensions: new Set(['.ts']) });
    expect(warn).not.toHaveBeenCalled();
  });
});
