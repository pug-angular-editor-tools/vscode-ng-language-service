/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import * as ts from 'typescript/lib/tsserverlibrary';
import * as lsp from 'vscode-languageserver';
import {URI} from 'vscode-uri';

import {htmlLocationToPugLocation, parse, State} from 'pug_html_locator_js';
const pugParser = require('pug-parser');
const pugLexer = require('pug-lexer');

export const isDebugMode = process.env['NG_DEBUG'] === 'true';

enum Scheme {
  File = 'file',
}

/**
 * Extract the file path from the specified `uri`.
 * @param uri
 */
export function uriToFilePath(uri: string): string {
  // Note: uri.path is different from uri.fsPath
  // See
  // https://github.com/microsoft/vscode-uri/blob/413805221cc6ed167186ab3103d3248d6f7161f2/src/index.ts#L622-L645
  const {scheme, fsPath} = URI.parse(uri);
  if (scheme !== Scheme.File) {
    return '';
  }
  return fsPath;
}

/**
 * Converts the specified `filePath` to a proper URI.
 * @param filePath
 */
export function filePathToUri(filePath: string): lsp.DocumentUri {
  return URI.file(filePath).toString();
}

/**
 * Converts ts.FileTextChanges to lsp.WorkspaceEdit.
 */
export function tsFileTextChangesToLspWorkspaceEdit(
    changes: readonly ts.FileTextChanges[],
    getScriptInfo: (path: string) => ts.server.ScriptInfo | undefined): lsp.WorkspaceEdit {
  const workspaceChanges: {[uri: string]: lsp.TextEdit[]} = {};
  for (const change of changes) {
    const scriptInfo = getScriptInfo(change.fileName);
    const uri = filePathToUri(change.fileName);
    if (scriptInfo === undefined) {
      continue;
    }
    if (!workspaceChanges[uri]) {
      workspaceChanges[uri] = [];
    }
    for (const textChange of change.textChanges) {
      const textEdit: lsp.TextEdit = {
        newText: textChange.newText,
        range: tsTextSpanToLspRange(scriptInfo, textChange.span),
      };
      workspaceChanges[uri].push(textEdit);
    }
  }
  return {
    changes: workspaceChanges,
  };
}

/**
 * Convert ts.TextSpan to lsp.TextSpan. TypeScript keeps track of offset using
 * 1-based index whereas LSP uses 0-based index.
 * @param scriptInfo Used to determine the offsets.
 * @param textSpan
 */
export function tsTextSpanToLspRange(scriptInfo: ts.server.ScriptInfo, textSpan: ts.TextSpan) {
  const start = scriptInfo.positionToLineOffset(textSpan.start);
  const end = scriptInfo.positionToLineOffset(textSpan.start + textSpan.length);
  // ScriptInfo (TS) is 1-based, LSP is 0-based.
  return lsp.Range.create(start.line - 1, start.offset - 1, end.line - 1, end.offset - 1);
}

/**
 * Convert lsp.Position to the absolute offset in the file. LSP keeps track of
 * offset using 0-based index whereas TypeScript uses 1-based index.
 * @param scriptInfo Used to determine the offsets.
 * @param position
 */
export function lspPositionToTsPosition(scriptInfo: ts.server.ScriptInfo, position: lsp.Position) {
  const {line, character} = position;
  // ScriptInfo (TS) is 1-based, LSP is 0-based.
  return scriptInfo.lineOffsetToPosition(line + 1, character + 1);
}

/**
 * Convert lsp.Range which is made up of `start` and `end` positions to
 * TypeScript's absolute offsets.
 * @param scriptInfo Used to determine the offsets.
 * @param range
 */
export function lspRangeToTsPositions(
    scriptInfo: ts.server.ScriptInfo, range: lsp.Range): [number, number] {
  const start = lspPositionToTsPosition(scriptInfo, range.start);
  const end = lspPositionToTsPosition(scriptInfo, range.end);
  return [start, end];
}

/**
 * Convert a ts.DiagnosticRelatedInformation array to a
 * lsp.DiagnosticRelatedInformation array
 * @param scriptInfo Used to determine the offsets.
 * @param relatedInfo
 */
export function tsRelatedInformationToLspRelatedInformation(
    scriptInfo: ts.server.ScriptInfo,
    relatedInfo?: ts.DiagnosticRelatedInformation[]): lsp.DiagnosticRelatedInformation[]|undefined {
  if (relatedInfo === undefined) return;
  const lspRelatedInfo: lsp.DiagnosticRelatedInformation[] = [];
  for (const info of relatedInfo) {
    if (info.file === undefined || info.start === undefined || info.length === undefined) continue;
    const textSpan: ts.TextSpan = {
      start: info.start,
      length: info.length,
    };
    const location = lsp.Location.create(
        filePathToUri(info.file.fileName),
        tsTextSpanToLspRange(scriptInfo, textSpan),
    );
    lspRelatedInfo.push(lsp.DiagnosticRelatedInformation.create(
        location,
        ts.flattenDiagnosticMessageText(info.messageText, '\n'),
        ));
  }
  return lspRelatedInfo;
}

export function isConfiguredProject(project: ts.server.Project):
    project is ts.server.ConfiguredProject {
  return project.projectKind === ts.server.ProjectKind.Configured;
}

/**
 * A class that tracks items in most recently used order.
 */
export class MruTracker {
  private readonly set = new Set<string>();

  update(item: string) {
    if (this.set.has(item)) {
      this.set.delete(item);
    }
    this.set.add(item);
  }

  delete(item: string) {
    this.set.delete(item);
  }

  /**
   * Returns all items sorted by most recently used.
   */
  getAll(): string[] {
    // Javascript Set maintains insertion order, see
    // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Set
    // Since items are sorted from least recently used to most recently used,
    // we reverse the result.
    return [...this.set].reverse();
  }
}

export function tsDisplayPartsToText(parts: ts.SymbolDisplayPart[]): string {
  return parts.map(dp => dp.text).join('');
}

interface DocumentPosition {
  fileName: string;
  pos: number;
}

/**
 *
 * This function attempts to use *internal* TypeScript APIs to find the original source spans for
 * the `ts.DefinitionInfo` using source maps. If it fails, this function returns the same
 * `ts.DefinitionInfo` that was passed in.
 *
 * @see https://github.com/angular/vscode-ng-language-service/issues/1588
 */
export function getMappedDefinitionInfo(
    info: ts.DefinitionInfo, project: ts.server.Project): ts.DefinitionInfo {
  try {
    const mappedDocumentSpan = getMappedDocumentSpan(info, project);
    return {...info, ...mappedDocumentSpan};
  } catch {
    return info;
  }
}

function getMappedDocumentSpan(
    documentSpan: ts.DocumentSpan, project: ts.server.Project): ts.DocumentSpan|undefined {
  const newPosition = getMappedLocation(documentSpanLocation(documentSpan), project);
  if (!newPosition) return undefined;
  return {
    fileName: newPosition.fileName,
    textSpan: {start: newPosition.pos, length: documentSpan.textSpan.length},
    originalFileName: documentSpan.fileName,
    originalTextSpan: documentSpan.textSpan,
    contextSpan: getMappedContextSpan(documentSpan, project),
    originalContextSpan: documentSpan.contextSpan
  };
}

function getMappedLocation(
    location: DocumentPosition, project: ts.server.Project): DocumentPosition|undefined {
  const mapsTo = (project as any).getSourceMapper().tryGetSourcePosition(location);
  return mapsTo &&
          (project.projectService as any).fileExists(ts.server.toNormalizedPath(mapsTo.fileName)) ?
      mapsTo :
      undefined;
}

function documentSpanLocation({fileName, textSpan}: ts.DocumentSpan): DocumentPosition {
  return {fileName, pos: textSpan.start};
}

function getMappedContextSpan(
    documentSpan: ts.DocumentSpan, project: ts.server.Project): ts.TextSpan|undefined {
  const contextSpanStart = documentSpan.contextSpan &&
      getMappedLocation({fileName: documentSpan.fileName, pos: documentSpan.contextSpan.start},
                        project);
  const contextSpanEnd = documentSpan.contextSpan &&
      getMappedLocation({
                          fileName: documentSpan.fileName,
                          pos: documentSpan.contextSpan.start + documentSpan.contextSpan.length
                         },
                        project);
  return contextSpanStart && contextSpanEnd ?
      {start: contextSpanStart.pos, length: contextSpanEnd.pos - contextSpanStart.pos} :
      undefined;
}

export function getPugParseError(scriptInfo: ts.server.ScriptInfo): {code: string; column: number; filename: string; line: number; msg: string;} | undefined {
  if (scriptInfo.fileName.endsWith('.pug')){
    const documentSnapshot = scriptInfo.getSnapshot()
    const documentText = documentSnapshot
    .getText(0, documentSnapshot.getLength());

    try {
      const tokens = pugLexer(documentText, {filename: scriptInfo.fileName});
      pugParser(tokens, {filename: scriptInfo.fileName, src: documentText});
    } catch (e) {
      return e;
    }
  }

  return;
}

export function getPugStateFromScriptInfo(scriptInfo: ts.server.ScriptInfo, logger: (message: string) => void): State | undefined {
  if (scriptInfo.fileName.endsWith('.pug')){
    const documentSnapshot = scriptInfo.getSnapshot()
    const documentText = documentSnapshot
    .getText(0, documentSnapshot.getLength());

    try {
      const tokens = pugLexer(documentText, {filename: scriptInfo.fileName});
      pugParser(tokens, {filename: scriptInfo.fileName, src: documentText});
    } catch (e) {
      return;
    }

    try {
      return parse(documentText);
    } catch (e) {
      logger(documentText + JSON.stringify(e))
    }
  }

  return;
}

export function pugOffsetToLspPosition(offset: number, state: State): lsp.Position {
  let line = 0;
  let col = 0;

  for (let i = 0; i < offset; i++) {
    if (state.pugText[i] === '\n') {
      line++;
      col = 0;
    } else {
      col++;
    }
  }

  return lsp.Position.create(line, col);
}

export function pugOffsetLocationLinks(links: lsp.LocationLink[], state: State, scriptInfo: ts.server.ScriptInfo): lsp.LocationLink[] {
  return links.map((link) => {
    if (!link.targetUri.endsWith(".pug")) {
      return link;
    }
    for (const attr of ["targetSelectionRange", "targetRange", "originSelectionRange"] as (keyof Pick<lsp.LocationLink, "targetSelectionRange" | "targetRange" | "originSelectionRange">)[]) {
      const range = structuredClone(link[attr]);
      if (!range) {
        continue;
      }

      for (const pos of ["start", "end"] as (keyof lsp.Range)[]) {
        if (!range[pos]) {
          continue;
        }
        range[pos] = pugOffsetToLspPosition(htmlLocationToPugLocation(lspPositionToTsPosition(scriptInfo, range[pos]), state), state)
        link[attr] = range;
      }
    }
    return link;
  });
}
