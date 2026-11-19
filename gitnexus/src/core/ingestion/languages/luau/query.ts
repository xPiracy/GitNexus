import Parser from 'tree-sitter';
import { requireVendoredGrammar } from '../../../tree-sitter/vendored-grammars.js';

let parser: Parser | undefined;

/** One parser per worker. The grammar is the same vendored grammar used by the parse pipeline. */
export function getLuauParser(): Parser {
  if (parser === undefined) {
    parser = new Parser();
    parser.setLanguage(requireVendoredGrammar('tree-sitter-luau'));
  }
  return parser;
}
