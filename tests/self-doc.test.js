import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { appendLesson, selfDoc, useLearnedFile } from '../src/skills/self-doc.js'

// SELF.md 跟着代码走，是多人共用的基线；本机学到的东西写 data/self-learned.md，
// 不进仓库。分开的原因：谁 push 一次 SELF.md 就改了所有机器人的自我认知。

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selfdoc-'))
const learned = path.join(tmpDir, 'self-learned.md')
useLearnedFile(learned)
test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

test('本机经验写进 data 下的文件，不动 SELF.md', () => {
  const before = fs.readFileSync(path.resolve('SELF.md'), 'utf8')

  const result = appendLesson({
    symptom: '测试用的症状',
    cause: '因为这样',
    fix: '所以那样',
  })

  assert.equal(result.duplicated, false)
  assert.match(result.line, /测试用的症状 → 因为这样 → 所以那样/)

  const after = fs.readFileSync(path.resolve('SELF.md'), 'utf8')
  assert.equal(after, before, 'SELF.md 一个字都不能变')

  assert.ok(fs.existsSync(learned), '本机经验文件要建出来')
  assert.match(fs.readFileSync(learned, 'utf8'), /测试用的症状/)
})

test('selfDoc 把基线和本机经验拼起来，本机带自己的标题', () => {
  const doc = selfDoc()
  assert.match(doc, /自身能力说明|踩坑记录/, '基线内容要在')
  assert.match(doc, /本机积累的经验（只在这台机器上有）/, '本机部分要带标题')
  assert.match(doc, /测试用的症状/)
})

test('同一条经验不重复记', () => {
  const again = appendLesson({ symptom: '测试用的症状', fix: '所以那样' })
  assert.equal(again.duplicated, true)
  const count = (fs.readFileSync(learned, 'utf8').match(/测试用的症状/g) ?? []).length
  assert.equal(count, 1)
})

test('缺字段直接拒，不写脏数据', () => {
  assert.throws(() => appendLesson({ fix: '只有做法' }), /symptom/)
  assert.throws(() => appendLesson({ symptom: '只有症状' }), /fix/)
})
