import assert from 'node:assert/strict'
import test from 'node:test'
import { moonPhase, solarDay } from '../src/almanac.ts'

const utc = (year: number, month: number, day: number, hour = 0, minute = 0) =>
  new Date(Date.UTC(year, month - 1, day, hour, minute))

const utcMinutes = (date: Date) => date.getUTCHours() * 60 + date.getUTCMinutes()

test('equator sunrise and sunset stay near 06:00 and 18:00 UTC', () => {
  const day = solarDay(utc(2026, 3, 20), 0, 0)
  assert.ok(day.sunrise)
  assert.ok(day.sunset)
  assert.ok(Math.abs(utcMinutes(day.sunrise) - 360) <= 15, `${utcMinutes(day.sunrise)}`)
  assert.ok(Math.abs(utcMinutes(day.sunset) - 1080) <= 15, `${utcMinutes(day.sunset)}`)
  assert.equal(day.polar, null)
})

test('Greenwich solstice has a long day', () => {
  const day = solarDay(utc(2026, 6, 21), 51.4779, -0.0015)
  assert.ok(day.sunrise)
  assert.ok(day.sunset)
  assert.ok(Math.abs(utcMinutes(day.sunrise) - 223) <= 15, `${utcMinutes(day.sunrise)}`)
  assert.ok(Math.abs(utcMinutes(day.sunset) - 1221) <= 15, `${utcMinutes(day.sunset)}`)
  assert.ok(day.dayLengthMinutes && day.dayLengthMinutes > 980)
})

test('polar day and polar night are detected', () => {
  const summer = solarDay(utc(2026, 6, 21), 69.65, 18.96)
  assert.equal(summer.polar, 'day')
  assert.equal(summer.sunrise, null)
  assert.equal(summer.dayLengthMinutes, null)
  const winter = solarDay(utc(2026, 12, 21), 69.65, 18.96)
  assert.equal(winter.polar, 'night')
  assert.equal(winter.sunset, null)
})

test('moon phase matches known new and full moons', () => {
  const newMoon = moonPhase(utc(2024, 4, 8, 18, 21))
  assert.ok(Math.min(newMoon.phase, 1 - newMoon.phase) < 0.03, `${newMoon.phase}`)
  assert.equal(newMoon.name, 'new')
  const fullMoon = moonPhase(utc(2024, 3, 25, 7, 0))
  assert.ok(Math.abs(fullMoon.phase - 0.5) < 0.03, `${fullMoon.phase}`)
  assert.equal(fullMoon.name, 'full')
  assert.ok(fullMoon.illumination > 0.98)
})
