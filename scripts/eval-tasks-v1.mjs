#!/usr/bin/env node
/**
 * Run the docs/evaluation/tasks-v1.md battery against one SearXNG endpoint:
 * a tune bracket before and after, and 36 sequential queries with a 2.5 s gap,
 * capturing each task's top five (url/title/snippet/engine) to JSONL for
 * snippet-level judgment per docs/evaluation/README.md.
 *
 * The task list is embedded from tasks-v1.md; a new task-set version requires a
 * new script version and a note in the report that used it (same rule as the README).
 * Judgment is performed by a human from the capture — this script only measures.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const GAP_MS = 2_500
const QUERY_TIMEOUT_MS = 30_000

const TASKS = [
  ['N1', '清华大学 计算机科学与技术系 官网'], ['N2', '中国科学院 学位论文 数据库'], ['N3', '国家自然科学基金委 官网'],
  ['N4', '上海市 住房公积金 网上服务'], ['N5', '12306 铁路客户服务中心'], ['N6', '中国人民银行 利率 公告'],
  ['N7', '哔哩哔哩 直播 首页'], ['N8', '粤港澳大湾区 一站通 政务服务'], ['N9', '北京大学 图书馆 馆藏检索'], ['N10', '浙江省 高考 成绩查询 官方'],
  ['R1', '个人养老金 制度 年缴费上限 2026'], ['R2', '电动自行车 新国标 强制标准 内容'], ['R3', '居住证 积分 落户 上海 条件'],
  ['R4', '增值税 留抵退税 政策 范围'], ['R5', '丙型肝炎 直接抗病毒药物 治愈率'], ['R6', '中国 碳排放权交易市场 覆盖行业'],
  ['R7', '深海一号 天然气 田 产能'], ['R8', '高考 强基计划 选拔流程'], ['R9', '长城 保护 条例 核心内容'], ['R10', 'algae 生物柴油 最新研究 进展'],
  ['T1', 'kubernetes node not ready 排查'], ['T2', 'React server components 原理 教程'], ['T3', 'pytorch dataloader num_workers 最佳实践'],
  ['T4', 'postgres WAL archiving 配置 步骤'], ['T5', 'grpc deadline retry 语义'], ['T6', 'redis cluster resharding 命令'],
  ['T7', 'type discriminant union typescript 收窄'], ['T8', 'openssl 证书 链 验证 失败'],
  ['F1', '今日 财经 要闻'], ['F2', 'latest node.js LTS version'], ['F3', '本周末 天气 预报 北京'], ['F4', '最新 大模型 发布'],
  ['C1', 'compose file reference docker'], ['C2', 'abort signal fetch api mdn'], ['C3', 'rust borrow checker explanation'], ['C4', 'ietf rfc 9110 http semantics'],
]

function parseArgs(argv) {
  const options = {
    base: 'http://127.0.0.1:8080',
    out: './eval-tasks-v1',
    cli: join(here, '..', 'lib', 'cli.mjs'),
    profile: 'web',
    noTune: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--base') options.base = argv[++i]
    else if (arg === '--out') options.out = argv[++i]
    else if (arg === '--cli') options.cli = argv[++i]
    else if (arg === '--profile') options.profile = argv[++i]
    else if (arg === '--no-tune') options.noTune = true
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: node scripts/eval-tasks-v1.mjs [--base URL] [--out DIR] [--cli PATH] [--profile NAME] [--no-tune]')
      process.exit(0)
    } else {
      console.error(`unknown argument: ${arg}`)
      process.exit(2)
    }
  }
  return options
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function tune(cli, profile, outFile) {
  const { stdout } = await run('node', [cli, 'tune', '--profile', profile, '--json'], { maxBuffer: 16 * 1024 * 1024 })
  writeFileSync(outFile, stdout)
}

async function query(base, task, q) {
  const startedAt = performance.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), QUERY_TIMEOUT_MS)
  try {
    const response = await fetch(`${base}/search?q=${encodeURIComponent(q)}&format=json`, { signal: controller.signal })
    const ms = Math.round(performance.now() - startedAt)
    if (!response.ok) return { task, q, ms, error: `HTTP ${response.status}` }
    const body = await response.json()
    const top5 = (body.results ?? []).slice(0, 5).map((r) => ({
      url: r.url,
      title: r.title,
      snippet: (r.content ?? '').slice(0, 400),
      engine: r.engine,
    }))
    return { task, q, ms, count: body.results?.length ?? 0, unresponsive: body.unresponsive_engines ?? [], top5 }
  } catch (error) {
    return { task, q, ms: Math.round(performance.now() - startedAt), error: String(error?.message ?? error).slice(0, 200) }
  } finally {
    clearTimeout(timer)
  }
}

const options = parseArgs(process.argv.slice(2))
const outDir = resolve(process.cwd(), options.out)
mkdirSync(outDir, { recursive: true })
const batteryPath = join(outDir, 'battery.jsonl')
writeFileSync(batteryPath, '')

const maybeTune = options.noTune
  ? async (label) => { console.log(`[tune ${label}] skipped (--no-tune)`) }
  : async (label) => {
      await tune(resolve(options.cli), options.profile, join(outDir, `tune-${label}.json`))
      console.log(`[tune ${label}] captured`)
    }

console.log(`base=${options.base} out=${outDir}`)
await maybeTune('before')
for (const [task, q] of TASKS) {
  const row = await query(options.base, task, q)
  appendFileSync(batteryPath, `${JSON.stringify(row)}\n`)
  console.log(`[${task}] ${row.ms}ms count=${row.count ?? '-'} ${row.error ?? ''}`)
  await sleep(GAP_MS)
}
await maybeTune('after')
console.log('DONE')
