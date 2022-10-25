import * as vscode from "vscode";

import { complete, hover, parse } from "github-actions-parser";

import { getGitHubContextForDocumentUri } from "../git/repository";
import { safeLoad } from 'yaml-ast-parser'
import { YAMLNode } from "github-actions-parser/dist/types";

const WorkflowSelector = {
  pattern: "**/.github/workflows/*.{yaml,yml}",
};

export function init(context: vscode.ExtensionContext) {
  // Register auto-complete
  vscode.languages.registerCompletionItemProvider(
    WorkflowSelector,
    new WorkflowCompletionItemProvider(),
    "."
  );

  vscode.languages.registerHoverProvider(
    WorkflowSelector,
    new WorkflowHoverProvider()
  );

  //
  // Provide diagnostics information
  //
  const collection =
    vscode.languages.createDiagnosticCollection("github-actions");
  if (vscode.window.activeTextEditor) {
    updateDiagnostics(vscode.window.activeTextEditor.document, collection);
  }
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        updateDiagnostics(editor.document, collection);
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) =>
      updateDiagnostics(e.document, collection)
    )
  );

  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((doc) => collection.delete(doc.uri))
  );

  registerFigSupport()

  vscode.window.onDidChangeActiveTextEditor(() => registerFigSupport())
}

function getSupportedDocumentAst(document: vscode.TextDocument) {
  if (!document.fileName.match("(.*)?.github/workflows/(.*).ya?ml")) return
  return simpleYamlParse(document)
}

let figSupportRegistered = false
async function registerFigSupport() {
  // register support lazily
  const { activeTextEditor } = vscode.window
  if (!activeTextEditor || !vscode.languages.match(WorkflowSelector, activeTextEditor.document)) return
  const figExtension = vscode.extensions.getExtension('undefined_publisher.fig-unreleased')
  if (!figExtension) return
  if (figSupportRegistered) return
  figSupportRegistered = true
  const api = await figExtension.activate()

  const enablePath = ['jobs', '*', 'steps', 'run']
  // todo change default cwd to repo root
  api.registerLanguageSupport(
    'yaml',
    {
        provideSingleLineRangeFromPosition(document: vscode.TextDocument, position: vscode.Position): vscode.Range | undefined {
          const ast = getSupportedDocumentAst(document)
          if (!ast) return

          const offset = document.offsetAt(position);

          const {path, node} = findNode(ast, offset)
          const value = node?.value;
          if (value && offset >= value.startPosition && offset <= value.endPosition) {
            const isInRun = enablePath.length === path.length && path.every((val, i) => {
              const expectedVal = enablePath[i]
              if (expectedVal === '*') return true
              return expectedVal === val
            })
            if (isInRun) {
              const ranges = getNodeCommandRanges(document, value)
              return ranges.find((range) => range.contains(position))
            }
          }
        },
        getAllSingleLineCommandLocations(document: vscode.TextDocument): vscode.Range[] | undefined {
          const ast = getSupportedDocumentAst(document)
          if (!ast) return

          const allMatchingNodes = getAllMatchingNodes(ast, enablePath);
          return allMatchingNodes.flatMap((valueNode) => getNodeCommandRanges(document, valueNode))
        }
    },
  )
}

function simpleYamlParse(document: vscode.TextDocument) {
  return safeLoad(document.getText())
}

const getNodeCommandRanges = (document: vscode.TextDocument, value: YAMLNode['value']) => {
  const valStartOffset = document.positionAt(value.startPosition)
  const valEndOffset = document.positionAt(value.endPosition)
  const ranges: vscode.Range[] = []
  const rawText = value.rawValue;
  if (rawText.startsWith('|')) {
    const lineMatches = [...rawText.matchAll(/^(\s*)(.+)$/gm)].slice(1)
    for (const match of lineMatches) {
      const startOffset = value.startPosition + match.index + match[1].length
      const endOffset = startOffset + match[2].length
      ranges.push(new vscode.Range(document.positionAt(startOffset), document.positionAt(endOffset)))
    }
  } else {
    ranges.push(new vscode.Range(valStartOffset, valEndOffset))
  }
  return ranges
}

// much simpler than what lib provides, but ofc I think it should be replaced
function findNode(input: YAMLNode, position: number) {
  const path: string[] = []
  function find(node: YAMLNode): YAMLNode | undefined {
    if (position >= node.startPosition && position <= node.endPosition) {
      const key = node.key?.value
      if (key) path.push(key)
      const children = node.mappings ?? node.value?.mappings ?? node.value?.items ?? []
      for (const child of children) {
        const foundNode = find(child)
        if (foundNode) return foundNode
      }
      return node
    }
  }
  return { node: find(input), path }
}

const getAllMatchingNodes = (input: YAMLNode, path: string[]) => {
  const nodes: YAMLNode['value'][] = []
  const collect = (node: YAMLNode, depth: number): any => {
    const key = node.key?.value
    const expectedKey = path[depth]
    if (key) {
      if (expectedKey !== '*' && expectedKey !== key) return false
      if (depth === path.length - 1) {
        if (node.value) nodes.push(node.value)
        return
      }
    }
    const nextDepth = key ? depth + 1 : depth
    const children = node.mappings ?? node.value?.mappings ?? node.value?.items ?? []
    for (const child of children) {
      collect(child, nextDepth)
    }
  }

  collect(input, 0)
  return nodes
}

async function updateDiagnostics(
  document: vscode.TextDocument,
  collection: vscode.DiagnosticCollection
): Promise<void> {
  if (
    document &&
    document.fileName.match("(.*)?.github/workflows/(.*).ya?ml")
  ) {
    collection.clear();

    const gitHubRepoContext = await getGitHubContextForDocumentUri(
      document.uri
    );
    if (!gitHubRepoContext) {
      return;
    }

    const result = await parse(
      {
        ...gitHubRepoContext,
        repository: gitHubRepoContext.name,
      },
      document.uri.fsPath,
      document.getText()
    );
    if (result.diagnostics.length > 0) {
      collection.set(
        document.uri,
        result.diagnostics.map((x) => ({
          severity: vscode.DiagnosticSeverity.Error,
          message: x.message,
          range: new vscode.Range(
            document.positionAt(x.pos[0]),
            document.positionAt(x.pos[1])
          ),
        }))
      );
    }
  } else {
    collection.clear();
  }
}

export class WorkflowHoverProvider implements vscode.HoverProvider {
  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<null | vscode.Hover> {
    try {
      const gitHubRepoContext = await getGitHubContextForDocumentUri(
        document.uri
      );
      if (!gitHubRepoContext) {
        return null;
      }

      const hoverResult = await hover(
        {
          ...gitHubRepoContext,
          repository: gitHubRepoContext.name,
        },
        document.uri.fsPath,
        document.getText(),
        document.offsetAt(position)
      );

      if (hoverResult?.description) {
        return {
          contents: [hoverResult?.description],
        };
      }
    } catch (e) {
      // TODO: CS: handle
      debugger;
    }

    return null;
  }
}

export class WorkflowCompletionItemProvider
  implements vscode.CompletionItemProvider
{
  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    cancellationToken: vscode.CancellationToken
  ): Promise<vscode.CompletionItem[]> {
    try {
      const gitHubRepoContext = await getGitHubContextForDocumentUri(
        document.uri
      );
      if (!gitHubRepoContext) {
        return [];
      }

      const completionResult = await complete(
        {
          ...gitHubRepoContext,
          repository: gitHubRepoContext.name,
        },
        document.uri.fsPath,
        document.getText(),
        document.offsetAt(position)
      );

      if (completionResult.length > 0) {
        return completionResult.map((x) => {
          const completionItem = new vscode.CompletionItem(
            x.value,
            vscode.CompletionItemKind.Constant
          );

          // Fix the replacement range. By default VS Code looks for the current word, which leads to duplicate
          // replacements for something like `runs-|` which auto-completes to `runs-runs-on`
          const text = document.getText(
            new vscode.Range(
              position.line,
              Math.max(0, position.character - x.value.length),
              position.line,
              position.character
            )
          );
          for (let i = x.value.length; i >= 0; --i) {
            if (text.endsWith(x.value.substr(0, i))) {
              completionItem.range = new vscode.Range(
                position.line,
                Math.max(0, position.character - i),
                position.line,
                position.character
              );
              break;
            }
          }

          if (x.description) {
            completionItem.documentation = new vscode.MarkdownString(
              x.description
            );
          }

          return completionItem;
        });
      }
    } catch (e) {
      // Ignore error
      return [];
    }

    return [];
  }
}
