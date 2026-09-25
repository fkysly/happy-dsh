// The fork's own workflows are the only ones nothing else validates.
//
// A workflow file that fails to parse is the quietest possible failure: GitHub
// reports no error, the run simply never happens and no check is created. For
// `happy-dsh-gates.yml` that would mean master's required checks stop reporting
// and every pull request blocks forever with nothing to point at; for
// `happy-dsh-release.yml` it would mean a pushed tag silently doing nothing.
// Upstream's workflows are not covered here — they are theirs to keep valid,
// and a YAML dialect difference in one of them should not fail this fork's gate.
import { globSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')
const workflows = globSync('.github/workflows/happy-dsh-*.yml', { cwd: root })
  .map(path => path.replaceAll('\\', '/'))
  .sort()

/** The job names a workflow declares, in declaration order. */
function jobNames(document: Record<string, unknown>): string[] {
  const jobs = document.jobs
  if (!isRecord(jobs)) return []
  return Object.values(jobs)
    .map(job => (isRecord(job) ? job.name : undefined))
    .filter((name): name is string => typeof name === 'string')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

describe('fork workflow files', () => {
  it('covers the workflows this fork owns', () => {
    // globSync with a cwd returns paths relative to that cwd, so this also
    // pins the two names the rest of the fork refers to.
    expect(workflows).toEqual([
      '.github/workflows/happy-dsh-gates.yml',
      '.github/workflows/happy-dsh-release.yml',
    ])
  })

  for (const path of workflows) {
    it(`${path} parses, and every job says where it runs`, () => {
      const document: unknown = yaml.load(readFileSync(resolve(root, path), 'utf8'))
      if (!isRecord(document)) throw new TypeError(`${path} must contain a workflow mapping`)
      if (typeof document.name !== 'string') throw new TypeError(`${path} must declare a workflow name`)
      const jobs = document.jobs
      if (!isRecord(jobs)) throw new TypeError(`${path} must declare jobs`)

      expect(jobNames(document).length).toBeGreaterThan(0)
      for (const [id, job] of Object.entries(jobs)) {
        if (!isRecord(job)) throw new TypeError(`${path}: job ${id} must be a mapping`)
        // A job without a runner is accepted by the parser, and then never
        // scheduled — the same silent nothing this file exists to catch.
        expect(typeof job['runs-on'], `${path}: job ${id}`).toBe('string')
      }
    })
  }
})
