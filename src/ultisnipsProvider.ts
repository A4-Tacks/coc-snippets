import { Document, ExtensionContext, OutputChannel, Position, Range, Uri, window, workspace } from 'coc.nvim'
import fs from 'fs'
import os from 'os'
import path from 'path'
import BaseProvider from './baseProvider'
import { FileItem, Snippet, SnippetEdit, TriggerKind, UltiSnipsConfig, UltiSnipsFile } from './types'
import UltiSnipsParser from './ultisnipsParser'
import { distinct, readdirAsync, statAsync, uid } from './util'

const pythonCodes: Map<string, string> = new Map()

export class UltiSnippetsProvider extends BaseProvider {
  private snippetFiles: UltiSnipsFile[] = []
  private loadedFiletypes: string[] = []
  private fileItems: FileItem[] = []
  private pyMethod: string
  private directories: string[] = []
  private parser: UltiSnipsParser
  constructor(
    private channel: OutputChannel,
    private trace: string,
    protected config: UltiSnipsConfig,
    private context: ExtensionContext
  ) {
    super(config)
    workspace.onDidSaveTextDocument(async doc => {
      let uri = Uri.parse(doc.uri)
      if (uri.scheme != 'file' || !doc.uri.endsWith('.snippets')) return
      let filepath = uri.fsPath
      if (!fs.existsSync(filepath)) return
      let idx = this.snippetFiles.findIndex(s => s.filepath == filepath)
      if (idx !== -1) {
        const snippetFile = this.snippetFiles[idx]
        this.snippetFiles.splice(idx, 1)
        await this.loadSnippetsFromFile(snippetFile.filetype, snippetFile.directory, filepath)
      } else {
        let filetype = filetypeFromBasename(path.basename(filepath, '.snippets'))
        await this.loadSnippetsFromFile(filetype, path.dirname(filepath), filepath)
      }
    }, null, this.context.subscriptions)
  }

  public async init(): Promise<void> {
    let { nvim, env } = workspace
    let { config } = this
    for (let dir of config.directories) {
      this.directories.push(workspace.expand(dir))
    }
    this.channel.appendLine(`[Info ${(new Date()).toLocaleTimeString()}] Using ultisnips directories: ${this.directories.join(' ')}`)
    let hasPythonx = await nvim.call('has', ['pythonx'])
    if (hasPythonx && config.usePythonx) {
      this.pyMethod = 'pyx'
    } else {
      this.pyMethod = config.pythonVersion == 3 ? 'py3' : 'py'
    }
    this.channel.appendLine(`[Info ${(new Date()).toLocaleTimeString()}] Using ultisnips python command: ${this.pyMethod}`)
    this.parser = new UltiSnipsParser(this.pyMethod, this.channel, this.trace)
    this.fileItems = await this.laodAllFilItems(env.runtimepath)
    workspace.onDidRuntimePathChange(async e => {
      let subFolders = await this.getSubFolders()
      for (const dir of e) {
        let res = await this.getSnippetsFromPlugin(dir, subFolders)
        this.fileItems.push(...res)
      }
    }, null, this.context.subscriptions)
    let filepath = this.context.asAbsolutePath('python/ultisnips.py')
    await workspace.nvim.command(`exe '${this.pyMethod}file '.fnameescape('${filepath}')`)
    for (let filetype of workspace.filetypes) {
      await this.loadByFiletype(filetype)
    }
    workspace.onDidCloseTextDocument(async e => {
      let doc = workspace.getDocument(e.bufnr)
      if (doc && !this.loadedFiletypes.includes(doc.filetype)) {
        await this.loadByFiletype(doc.filetype)
      }
    }, null, this.context.subscriptions)
  }

  private async loadByFiletype(filetype: string): Promise<void> {
    let items = this.getFileItems(filetype)
    if (items.length) {
      await this.loadFromItems(items)
      this.loadedFiletypes.push(filetype)
    }
  }

  private getFileItems(filetype: string): FileItem[] {
    let filetypes = this.getFiletypes(filetype)
    filetypes.push('all')
    return this.fileItems.filter(o => filetypes.includes(o.filetype))
  }

  private async loadFromItems(items: FileItem[]): Promise<void> {
    if (items.length) {
      await Promise.all(items.map(({ filepath, directory, filetype }) => {
        return this.loadSnippetsFromFile(filetype, directory, filepath)
      }))
      let pythonCode = ''
      for (let [file, code] of pythonCodes.entries()) {
        pythonCode += `# ${file}\n` + code + '\n'
      }
      if (pythonCode) {
        pythonCodes.clear()
        await this.executePythonCode(pythonCode)
      }
    }
  }

  public async loadSnippetsFromFile(filetype: string, directory: string, filepath: string): Promise<void> {
    let idx = this.snippetFiles.findIndex(o => o.filepath == filepath)
    if (idx !== -1) return
    let { snippets, pythonCode, extendFiletypes, clearsnippets } = await this.parser.parseUltisnipsFile(filepath)
    this.snippetFiles.push({
      extendFiletypes,
      clearsnippets,
      directory,
      filepath,
      filetype,
      snippets
    })
    if (extendFiletypes?.length) {
      let filetypes = this.config.extends[filetype] || []
      filetypes = filetypes.concat(extendFiletypes)
      this.config.extends[filetype] = distinct(filetypes)
      for (let f of extendFiletypes) {
        let items = this.getFileItems(f)
        await Promise.all(items.map(item => {
          return this.loadSnippetsFromFile(item.filetype, item.directory, item.filepath)
        }))
      }
    }
    this.channel.appendLine(`[Info ${(new Date()).toISOString()}] Loaded ${snippets.length} UltiSnip snippets from: ${filepath}`)
    pythonCodes.set(filepath, pythonCode)
  }

  public async resolveSnippetBody(snippet: Snippet, range: Range, line: string): Promise<string> {
    let { nvim } = workspace
    let { body, context, originRegex } = snippet
    let indentCount = await nvim.call('indent', '.') as number
    let ind = ' '.repeat(indentCount)
    if (body.indexOf('`!p') !== -1) {
      let values: Map<number, string> = new Map()
      let re = /\$\{(\d+)(?::([^}]+))?\}/g
      let r
      // tslint:disable-next-line: no-conditional-assignment
      while (r = re.exec(body)) {
        let idx = parseInt(r[1], 10)
        let val: string = r[2] || ''
        let exists = values.get(idx)
        if (exists == null || (val && exists == "''")) {
          if (/^`!\w/.test(val) && val.endsWith('`')) {
            let code = val.slice(1).slice(0, -1)
            // not execute python code since we don't have snip yet.
            if (code.startsWith('!p')) {
              val = ''
            } else {
              val = await this.parser.execute(code, this.pyMethod, ind)
            }
          }
          val = val.replace(/'/g, "\\'").replace(/\n/g, '\\n')
          values.set(idx, "r'" + val + "'")
        }
      }
      re = /\$(\d+)/g
      // tslint:disable-next-line: no-conditional-assignment
      while (r = re.exec(body)) {
        let idx = parseInt(r[1], 10)
        if (!values.has(idx)) {
          values.set(idx, "''")
        }
      }
      let len = values.size == 0 ? 0 : Math.max.apply(null, Array.from(values.keys()))
      let vals = (new Array(len)).fill('""')
      for (let [idx, val] of values.entries()) {
        vals[idx] = val
      }
      let pyCodes: string[] = [
        'import re, os, vim, string, random',
        `t = (${vals.join(',')})`,
        `fn = vim.eval('expand("%:t")') or ""`,
        `path = vim.eval('expand("%:p")') or ""`
      ]
      if (context) {
        pyCodes.push(`snip = ContextSnippet()`)
        pyCodes.push(`context = ${context}`)
      } else {
        pyCodes.push(`context = {}`)
      }
      let start = `(${range.start.line},${Buffer.byteLength(line.slice(0, range.start.character))})`
      let end = `(${range.end.line},${Buffer.byteLength(line.slice(0, range.end.character))})`
      pyCodes.push(`snip = SnippetUtil('${ind}', ${start}, ${end}, context)`)
      if (originRegex) {
        pyCodes.push(`pattern = re.compile(r"${originRegex.replace(/"/g, '\\"')}")`)
        pyCodes.push(`match = pattern.search("${line.replace(/"/g, '\\"')}")`)
      }
      await nvim.command(`${this.pyMethod} ${this.addPythonTryCatch(pyCodes.join('\n'))}`)
    }
    return this.parser.resolveUltisnipsBody(body)
  }

  /**
   * vim8 doesn't throw any python error with :py command
   * we have to use g:errmsg since v:errmsg can't be changed in python script.
   */
  private addPythonTryCatch(code: string): string {
    if (!workspace.isVim) return code
    let lines = [
      'import traceback, vim',
      `vim.vars['errmsg'] = ''`,
      'try:',
    ]
    lines.push(...code.split('\n').map(line => '    ' + line))
    lines.push('except Exception as e:')
    lines.push(`    vim.vars['errmsg'] = traceback.format_exc()`)
    return lines.join('\n')
  }

  public async checkContext(context: string): Promise<any> {
    let { nvim } = workspace
    let pyCodes: string[] = [
      'import re, os, vim, string, random',
      'snip = ContextSnippet()',
      `context = ${context}`
    ]
    await nvim.command(`${this.pyMethod} ${this.addPythonTryCatch(pyCodes.join('\n'))}`)
    return await nvim.call(`${this.pyMethod}eval`, 'True if context else False')
  }

  public async getTriggerSnippets(document: Document, position: Position, autoTrigger?: boolean): Promise<SnippetEdit[]> {
    let snippets = await this.getSnippets(document.filetype)
    let line = document.getline(position.line)
    line = line.slice(0, position.character)
    if (!line || line[line.length - 1] == ' ') return []
    snippets = snippets.filter(s => {
      let { prefix, regex } = s
      if (autoTrigger && !s.autoTrigger) return false
      if (regex) {
        let ms = line.match(regex)
        if (!ms) return false
        prefix = ms[0]
      }
      if (!line.endsWith(prefix)) return false
      if (s.triggerKind == TriggerKind.InWord) return true
      let pre = line.slice(0, line.length - prefix.length)
      if (s.triggerKind == TriggerKind.LineBegin) return pre.trim() == ''
      if (s.triggerKind == TriggerKind.SpaceBefore) return pre.length == 0 || /\s/.test(pre[pre.length - 1])
      if (s.triggerKind == TriggerKind.WordBoundary) return pre.length == 0 || !document.isWord(pre[pre.length - 1])
      return false
    })
    snippets.sort((a, b) => {
      if (a.context && !b.context) return -1
      if (b.context && !a.context) return 1
      return 0
    })
    let edits: SnippetEdit[] = []
    let contextPrefixes: string[] = []
    for (let s of snippets) {
      let character: number
      if (s.context) {
        let valid = await this.checkContext(s.context)
        if (!valid) continue
        contextPrefixes.push(s.context)
      } else if (contextPrefixes.indexOf(s.prefix) !== -1) {
        continue
      }
      if (s.regex == null) {
        character = position.character - s.prefix.length
      } else {
        let len = line.match(s.regex)[0].length
        character = position.character - len
      }
      let range = Range.create(position.line, character, position.line, position.character)
      let newText = await this.resolveSnippetBody(s, range, line)
      edits.push({
        prefix: s.prefix,
        description: s.description,
        location: s.filepath,
        priority: s.priority,
        range,
        newText,
      })
    }
    return edits
  }

  public async getSnippetFiles(filetype: string): Promise<string[]> {
    let filetypes = this.getFiletypes(filetype)
    let res: string[] = []
    for (let s of this.snippetFiles) {
      if (filetypes.indexOf(s.filetype) !== -1) {
        res.push(s.filepath)
      }
    }
    return res
  }

  public async getSnippets(filetype: string): Promise<Snippet[]> {
    let filetypes = this.getFiletypes(filetype)
    filetypes.push('all')
    let snippetFiles = this.snippetFiles.filter(o => filetypes.indexOf(o.filetype) !== -1)
    let min: number = null
    let result: Snippet[] = []
    snippetFiles.sort((a, b) => {
      if (a.filetype == b.filetype) return 1
      if (a.filetype == filetype) return -1
      return 1
    })
    for (let file of snippetFiles) {
      let { snippets, clearsnippets } = file
      if (typeof clearsnippets == 'number') {
        min = min ? Math.max(min, clearsnippets) : clearsnippets
      }
      for (let snip of snippets) {
        if (snip.regex || snip.context) {
          result.push(snip)
        } else {
          let idx = result.findIndex(o => o.prefix == snip.prefix && o.triggerKind == snip.triggerKind)
          if (idx == -1) {
            result.push(snip)
          } else {
            let item = result[idx]
            if (snip.priority > item.priority) {
              result[idx] = item
            }
          }
        }
      }
    }
    if (min != null) result = result.filter(o => o.priority >= min)
    result.sort((a, b) => {
      if (a.context && !b.context) return -1
      if (b.context && !a.context) return 1
      return 0
    })
    return result
  }

  public async laodAllFilItems(runtimepath: string): Promise<FileItem[]> {
    let { directories } = this
    let res: FileItem[] = []
    for (let directory of directories) {
      if (path.isAbsolute(directory)) {
        let items = await this.getSnippetFileItems(directory)
        res.push(...items)
      }
    }
    let subFolders = await this.getSubFolders()
    let rtps = runtimepath.split(',')
    for (let rtp of rtps) {
      let items = await this.getSnippetsFromPlugin(rtp, subFolders)
      res.push(...items)
    }
    return res
  }

  public async getSubFolders(): Promise<string[]> {
    let { directories } = this
    directories = directories.filter(s => !path.isAbsolute(s))
    // use UltiSnipsSnippetDirectories
    let dirs = await workspace.nvim.eval('get(g:, "UltiSnipsSnippetDirectories", [])') as string[]
    for (let dir of dirs) {
      if (directories.indexOf(dir) == -1) {
        directories.push(dir)
      }
    }
    return directories
  }

  private async getSnippetsFromPlugin(directory: string, subFolders: string[]): Promise<FileItem[]> {
    let res: FileItem[] = []
    for (let folder of subFolders) {
      let items = await this.getSnippetFileItems(path.join(directory, folder))
      res.push(...items)
    }
    return res
  }

  private async getSnippetFileItems(directory: string): Promise<FileItem[]> {
    let res: FileItem[] = []
    let stat = await statAsync(directory)
    if (stat && stat.isDirectory()) {
      let files = await readdirAsync(directory)
      if (files.length) {
        for (let f of files) {
          let file = path.join(directory, f)
          if (file.endsWith('.snippets')) {
            let basename = path.basename(f, '.snippets')
            let filetype = filetypeFromBasename(basename)
            res.push({ filepath: file, directory, filetype })
          } else {
            let stat = await statAsync(file)
            if (stat && stat.isDirectory()) {
              let files = await readdirAsync(file)
              for (let filename of files) {
                if (filename.endsWith('.snippets')) {
                  res.push({ filepath: path.join(file, filename), directory, filetype: f })
                }
              }
            }
          }
        }
      }
    }
    return res
  }

  private async executePythonCode(pythonCode: string): Promise<void> {
    try {
      let dir = path.join(os.tmpdir(), `coc.nvim-${process.pid}`)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir)
      let tmpfile = path.join(os.tmpdir(), `coc.nvim-${process.pid}`, `coc-ultisnips-${uid()}.py`)
      let code = this.addPythonTryCatch(pythonCode)
      fs.writeFileSync(tmpfile, '# -*- coding: utf-8 -*-\n' + code, 'utf8')
      this.channel.appendLine(`[Info ${(new Date()).toISOString()}] Execute python code in: ${tmpfile}`)
      await workspace.nvim.command(`exe '${this.pyMethod}file '.fnameescape('${tmpfile}')`)
    } catch (e) {
      this.channel.appendLine(`Error on execute python script:`)
      this.channel.append(e.message)
      window.showMessage(`Error on execute python script: ${e.message}`, 'error')
    }
  }
}

function filetypeFromBasename(basename: string): string {
  if (basename == 'typescript_react') return 'typescriptreact'
  if (basename == 'javascript_react') return 'javascriptreact'
  return basename.split('-', 2)[0]
}
