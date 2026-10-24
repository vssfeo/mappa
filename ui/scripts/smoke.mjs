import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const url = process.env.MAPPA_URL ?? 'http://127.0.0.1:4173/'
const projectDir = fileURLToPath(new URL('..', import.meta.url))
let server = null

const reachable = async () => {
  try {
    const response = await fetch(url)
    return response.ok
  } catch {
    return false
  }
}

if (!process.env.MAPPA_URL && !(await reachable())) {
  server = spawn(
    `${projectDir}/node_modules/.bin/vite`,
    ['preview', '--host', '127.0.0.1', '--port', '4173'],
    { cwd: projectDir, stdio: 'ignore' },
  )
  for (let attempt = 0; attempt < 50 && !(await reachable()); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
if (!(await reachable())) {
  console.error('SMOKE FAILED: preview server did not start')
  server?.kill()
  process.exit(1)
}

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []

page.on('console', (message) => {
  if (message.type() !== 'error') return
  const location = message.location()
  const source = location.url ? ` (${location.url})` : ''
  errors.push(`console: ${message.text()}${source}`)
})
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))

const fail = (message) => {
  errors.push(message)
}

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3000)

  if ((await page.locator('.maplibregl-canvas').count()) === 0) {
    fail('map canvas not found')
  }
  const providerOptions = await page
    .locator('.provider-select option')
    .allInnerTexts()
  for (const label of ['Esri World Imagery', 'NASA Blue Marble']) {
    if (!providerOptions.some((option) => option.trim() === label)) {
      fail(`satellite provider is missing: ${label}`)
    }
  }
  const hud = await page.locator('.hud-button').evaluateAll((buttons) =>
    buttons.map((button) => ({
      text: button.textContent?.trim() ?? '',
      tooltip: button.getAttribute('data-tooltip') ?? '',
    })),
  )
  if (hud.some((button) => button.text !== '')) {
    fail('map tools still have text labels')
  }
  if (hud.some((button) => button.tooltip === '')) {
    fail('a map tool is missing its hover tooltip')
  }

  const providerRows = page.locator('.layer-row:not(.pack-row)')
  if ((await providerRows.count()) < 2) {
    fail('basemap layer rows are missing')
  } else if ((await providerRows.locator('.layer-grip').count()) !== (await providerRows.count())) {
    fail('a basemap row is missing its drag handle')
  } else {
    const first = providerRows.first()
    const second = providerRows.nth(1)
    const firstId = await first.getAttribute('data-layer-id')
    const secondId = await second.getAttribute('data-layer-id')
    const grip = first.locator('.layer-grip')
    await grip.scrollIntoViewIfNeeded()
    const gripBox = await grip.boundingBox()
    const secondBox = await second.boundingBox()
    await page.mouse.move(gripBox.x + 8, gripBox.y + 8)
    await page.mouse.down()
    await page.mouse.move(gripBox.x + 10, gripBox.y + 18, { steps: 4 })
    await page.mouse.move(
      secondBox.x + 90,
      secondBox.y + secondBox.height - 3,
      { steps: 8 },
    )
    await page.mouse.up()
    await page.waitForTimeout(200)
    if ((await providerRows.first().getAttribute('data-layer-id')) !== secondId) {
      fail(`basemap drag did not reorder ${firstId} and ${secondId}`)
    }
  }

  await page.keyboard.press('c')
  await page.waitForTimeout(700)
  if ((await page.locator('.compare-overlay').count()) === 0) {
    fail('compare overlay did not open')
  }
  if ((await page.locator('.compare-map canvas').count()) === 0) {
    fail('compare map canvas is missing')
  }
  const divider = page.locator('.compare-divider')
  const splitBefore = await divider.getAttribute('aria-valuenow')
  await divider.focus()
  await page.keyboard.press('ArrowLeft')
  await page.waitForTimeout(200)
  const splitAfter = await divider.getAttribute('aria-valuenow')
  if (splitBefore === splitAfter) {
    fail('compare divider did not move with the keyboard')
  }
  await page.keyboard.press('c')
  await page.waitForTimeout(300)
  if ((await page.locator('.compare-overlay').count()) > 0) {
    fail('compare overlay did not close')
  }

  await page.keyboard.press('Control+K')
  await page.waitForTimeout(200)
  if ((await page.locator('.cmdk').count()) === 0) {
    fail('command palette did not open')
  }
  await page.keyboard.type('москва')
  await page.waitForTimeout(200)
  await page.keyboard.press('Escape')

  await page.locator('.primary-button').first().click()
  await page.waitForTimeout(300)
  if ((await page.locator('.download-sheet').count()) === 0) {
    fail('download sheet did not open')
  }
  const queueButton = page.locator('.download-sheet .secondary-button')
  if (!(await queueButton.isDisabled())) {
    fail('queue button should be disabled outside Tauri')
  }
  await page.keyboard.press('Escape')

  await page.keyboard.press('r')
  await page.waitForTimeout(200)
  if ((await page.locator('.draw-hint').count()) === 0) {
    fail('draw hint did not appear')
  }
  const canvas = page.locator('.maplibregl-canvas')
  const box = await canvas.boundingBox()
  await page.mouse.move(box.x + 300, box.y + 220)
  await page.mouse.down()
  await page.mouse.move(box.x + 620, box.y + 470, { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(300)
  if ((await page.locator('.draw-hint').count()) > 0) {
    fail('draw mode did not finish after mouse up')
  }
  await page.locator('.topbar .primary-button').click()
  await page.waitForTimeout(250)
  const selectionHeading = page.locator(
    '.download-sheet .sheet-field-heading span',
    { hasText: 'Выделенная область' },
  )
  if ((await selectionHeading.count()) === 0) {
    const headings = await page
      .locator('.download-sheet .sheet-field-heading span')
      .allInnerTexts()
    fail(
      `selection was not applied to the download sheet (${headings.join(' | ')})`,
    )
  }
  await page.keyboard.press('Escape')

  await page.keyboard.press('m')
  await page.waitForTimeout(200)
  if (!(await page.locator('.draw-hint').innerText()).includes('линии')) {
    fail('line measurement hint did not appear')
  }
  const measureBox = await canvas.boundingBox()
  for (const [x, y] of [
    [300, 240],
    [470, 330],
    [580, 230],
  ]) {
    await page.mouse.click(measureBox.x + x, measureBox.y + y)
  }
  await page.waitForTimeout(300)
  if ((await page.locator('.measure-label').count()) < 3) {
    fail('line measurement labels are missing')
  }
  if ((await page.locator('.measure-label.is-total').count()) !== 1) {
    fail('total line label is missing')
  }

  const panPoint = { x: measureBox.x + 700, y: measureBox.y + 350 }
  await page.mouse.move(panPoint.x, panPoint.y)
  await page.waitForTimeout(200)
  const beforePan = await page.locator('.status-coords').innerText()
  await page.mouse.down({ button: 'right' })
  await page.mouse.move(panPoint.x + 120, panPoint.y + 80, { steps: 10 })
  await page.mouse.up({ button: 'right' })
  await page.mouse.move(panPoint.x, panPoint.y)
  await page.waitForTimeout(400)
  const afterPan = await page.locator('.status-coords').innerText()
  if (beforePan === afterPan) {
    fail('right-drag did not pan the map during measurement')
  }

  const saveRoute = page.locator('.draw-hint .hint-action.is-primary')
  if ((await saveRoute.count()) === 0) {
    fail('save-route action is missing from the measurement hint')
  } else {
    await saveRoute.click()
    await page.waitForTimeout(350)
    if ((await page.locator('.feature-dot').count()) !== 1) {
      fail('measured route was not saved as a feature')
    }
    const routeName = await page
      .locator('.inspector .marker-name-input')
      .first()
      .inputValue()
    if (!routeName.startsWith('Маршрут')) {
      fail(`saved route has an unexpected name (${routeName})`)
    }
    await page
      .locator('.inspector button', { hasText: 'Удалить объект' })
      .first()
      .click()
    await page.waitForTimeout(250)
  }

  await page.keyboard.press('Escape')
  await page.waitForTimeout(250)
  if ((await page.locator('.measure-label').count()) > 0) {
    fail('measurement labels remained after Escape')
  }

  await page.keyboard.press('Shift+M')
  await page.waitForTimeout(200)
  for (const [x, y] of [
    [280, 230],
    [500, 230],
    [520, 400],
    [300, 390],
  ]) {
    await page.mouse.click(measureBox.x + x, measureBox.y + y)
  }
  await page.waitForTimeout(300)
  if ((await page.locator('.measure-label.is-area').count()) !== 1) {
    fail('polygon area label is missing')
  }
  await page.keyboard.press('Escape')
  await page.waitForTimeout(250)

  await page.keyboard.press('o')
  await page.waitForTimeout(250)
  const circleCenter = { x: measureBox.x + 350, y: measureBox.y + 300 }
  await page.mouse.click(circleCenter.x, circleCenter.y)
  await page.waitForTimeout(150)
  await page.mouse.move(circleCenter.x + 80, circleCenter.y)
  await page.waitForTimeout(250)
  await page.mouse.click(circleCenter.x + 80, circleCenter.y)
  await page.waitForTimeout(350)
  if ((await page.locator('.feature-dot').count()) !== 1) {
    fail('circle was not saved as a polygon')
  }
  const circleName = await page
    .locator('.inspector .marker-name-input')
    .first()
    .inputValue()
  if (!circleName.startsWith('Круг')) {
    fail(`circle has an unexpected name (${circleName})`)
  }
  await page.mouse.move(circleCenter.x, circleCenter.y)
  await page.waitForTimeout(350)
  const tooltip = page.locator('.feature-tooltip')
  if (!(await tooltip.isVisible())) {
    fail('feature tooltip did not appear on hover')
  } else if (!(await tooltip.innerText()).includes('Круг')) {
    fail(`feature tooltip has an unexpected label (${await tooltip.innerText()})`)
  }
  await page
    .locator('.inspector button', { hasText: 'Удалить объект' })
    .first()
    .click()
  await page.waitForTimeout(250)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(250)

  await page.keyboard.press('l')
  await page.waitForTimeout(250)
  if (!(await page.locator('.draw-hint').innerText()).includes('линии')) {
    fail('line drawing hint did not appear')
  }
  for (const [x, y] of [
    [260, 260],
    [420, 330],
    [560, 280],
  ]) {
    await page.mouse.click(measureBox.x + x, measureBox.y + y)
  }
  await page.keyboard.press('Enter')
  await page.waitForTimeout(350)
  if ((await page.locator('.feature-dot').count()) !== 1) {
    fail('drawn line was not added to the objects list')
  }
  await page.locator('.marker-row').first().click()
  const featureName = page.locator('.marker-name-input').first()
  await featureName.waitFor()
  await featureName.fill('Тестовая линия')
  await page.waitForTimeout(250)
  const featureRow = await page.locator('.marker-row').first().innerText()
  if (!featureRow.includes('Тестовая линия')) {
    fail(`feature rename was not applied (${featureRow})`)
  }
  if ((await page.locator('.track-player').count()) === 0) {
    fail('track player is missing for a line')
  } else {
    await page.locator('.track-player-toggle').click()
    await page.waitForTimeout(300)
    if ((await page.locator('.track-player-marker').count()) !== 1) {
      fail('track playback marker is missing')
    }
    await page.locator('.track-player-toggle').click()
  }

  await page.evaluate(() => (document.activeElement)?.blur())
  await page.keyboard.press('e')
  await page.waitForTimeout(250)
  if (!(await page.locator('.draw-hint').innerText()).includes('вершины')) {
    fail('vertex editing hint did not appear')
  }
  await page.keyboard.press('Delete')
  await page.waitForTimeout(250)
  if ((await page.locator('.feature-dot').count()) !== 0) {
    fail('selected feature was not deleted')
  }

  await page.keyboard.press('Shift+L')
  await page.waitForTimeout(250)
  for (const [x, y] of [
    [300, 520],
    [520, 520],
    [500, 660],
  ]) {
    await page.mouse.click(measureBox.x + x, measureBox.y + y)
  }
  await page.keyboard.press('Enter')
  await page.waitForTimeout(350)
  if ((await page.locator('.inspector button', { hasText: 'GPX' }).count()) === 0) {
    fail('GPX export button is missing')
  }
  const polygonDownload = page.locator('.inspector button', {
    hasText: 'Скачать',
  })
  if ((await polygonDownload.count()) === 0) {
    fail('polygon download button is missing')
  } else {
    await polygonDownload.first().click()
    await page.waitForTimeout(300)
    const polygonHeading = page.locator(
      '.download-sheet .sheet-field-heading span',
      { hasText: 'Полигон' },
    )
    if ((await polygonHeading.count()) === 0) {
      const headings = await page
        .locator('.download-sheet .sheet-field-heading span')
        .allInnerTexts()
      fail(
        `download sheet did not switch to the polygon (${headings.join(' | ')})`,
      )
    }
    await page.locator('.download-sheet .text-button', { hasText: 'Сбросить' }).click()
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
  }

  await page.keyboard.press('p')
  await page.waitForTimeout(200)
  await page.mouse.click(measureBox.x + 380, measureBox.y + 300)
  await page.waitForTimeout(350)
  if ((await page.locator('.marker-row').count()) !== 1) {
    fail('marker was not added to the list')
  }
  if ((await page.locator('.map-marker').count()) < 1) {
    fail('marker pin was not rendered on the map')
  }
  await page.locator('.marker-name-input').fill('Тестовая метка')
  await page.waitForTimeout(200)
  const markerLabel = await page.locator('.map-marker-label').first().innerText()
  if (markerLabel !== 'Тестовая метка') {
    fail(`marker rename was not reflected on the map (${markerLabel})`)
  }
  await page
    .locator('.marker-transfer-field select')
    .nth(1)
    .selectOption('utm')
  await page.waitForTimeout(200)
  const markerCoords = await page.locator('.marker-coords').first().innerText()
  if (!/^\d{1,2}[NS] \d+E \d+N$/.test(markerCoords)) {
    fail(`UTM marker coordinates look wrong (${markerCoords})`)
  }
  const statusCoords = await page.locator('.status-coords').innerText()
  if (!/^\d{1,2}[NS] \d+E \d+N$/.test(statusCoords)) {
    fail(`status bar did not switch to UTM (${statusCoords})`)
  }

  const markerCoordsBefore = await page
    .locator('.marker-coords')
    .first()
    .innerText()
  await page.evaluate(() => (document.activeElement)?.blur())
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  await page.keyboard.press('e')
  await page.waitForTimeout(250)
  const pin = page.locator('.map-marker').first()
  const pinBox = await pin.boundingBox()
  if (!pinBox) {
    fail('marker pin has no bounding box')
  } else {
    await page.mouse.move(
      pinBox.x + pinBox.width / 2,
      pinBox.y + pinBox.height / 2,
    )
    await page.mouse.down()
    await page.mouse.move(
      pinBox.x + pinBox.width / 2 + 70,
      pinBox.y + pinBox.height / 2 + 45,
      { steps: 8 },
    )
    await page.mouse.up()
    await page.waitForTimeout(300)
    await pin.click()
    await page.waitForTimeout(300)
    if ((await page.locator('.inspector h2').innerText()) !== 'Метки') {
      fail('clicking a point in edit mode did not open the point editor')
    }
    const markerCoordsAfter = await page
      .locator('.marker-coords')
      .first()
      .innerText()
    if (markerCoordsBefore === markerCoordsAfter) {
      fail('point was not moved in edit mode')
    }
    await page
      .locator('select[aria-label="Иконка метки"]')
      .selectOption('🚩')
    await page.waitForTimeout(250)
    const pointIcon = await page.locator('.marker-dot').first().innerText()
    if (!pointIcon.includes('🚩')) {
      fail('point icon did not change')
    }

    const coordInputs = page.locator('.coord-field input')
    const latField = coordInputs.nth(0)
    const lonField = coordInputs.nth(1)
    const heightField = coordInputs.nth(2)
    if (
      (await latField.count()) === 0 ||
      (await lonField.count()) === 0 ||
      (await heightField.count()) === 0
    ) {
      fail('point coordinate editor is missing B/L/h fields')
    } else {
      const fields = page.locator('.coord-field')
      const latBox = await fields.nth(0).boundingBox()
      const lonBox = await fields.nth(1).boundingBox()
      const heightBox = await fields.nth(2).boundingBox()
      if (!latBox || latBox.width < 120) {
        fail(`latitude field is too narrow (${latBox?.width})`)
      }
      if (
        !latBox ||
        !lonBox ||
        !heightBox ||
        Math.abs(latBox.width - lonBox.width) > 1 ||
        Math.abs(latBox.width - heightBox.width) > 1 ||
        !(latBox.y < lonBox.y && lonBox.y < heightBox.y)
      ) {
        fail(
          `B/L/h fields are not equal-width stacked rows (${JSON.stringify({ latBox, lonBox, heightBox })})`,
        )
      }
      const coordFormat = page.locator('.marker-coordinate-actions select')
      await coordFormat.selectOption('dd')
      await page.waitForTimeout(250)
      await latField.fill('55.75580')
      await lonField.fill('37.61730')
      await heightField.fill('145')
      await heightField.press('Enter')
      await page.waitForTimeout(400)
      const movedCoords = await page.locator('.marker-coords').first().innerText()
      if (!/^37N 413\d{3}E 6179\d{3}N$/.test(movedCoords)) {
        fail(`edited coordinates were not applied (${movedCoords})`)
      }
      const storedMarkers = await page.evaluate(() =>
        JSON.parse(localStorage.getItem('mappa-ui') ?? '{}')?.state?.markers,
      )
      const edited = Array.isArray(storedMarkers)
        ? storedMarkers.find((marker) => marker.name === 'Тестовая метка')
        : null
      if (!edited || edited.elevation !== 145) {
        fail(`point elevation was not stored (${JSON.stringify(edited)})`)
      }

      if ((await coordFormat.locator('option[value="sk42"]').count()) === 0) {
        fail('SK-42 coordinate system option is missing')
      }
      await coordFormat.selectOption('dms')
      await page.waitForTimeout(250)
      const dmsLat = await latField.inputValue()
      const dmsLon = await lonField.inputValue()
      if (!/°.*[NS]$/.test(dmsLat) || !/°.*[EW]$/.test(dmsLon)) {
        fail(`DMS fields were not formatted (${dmsLat} | ${dmsLon})`)
      }
      await coordFormat.selectOption('dd')
      await page.waitForTimeout(250)
      const decimalLat = await latField.inputValue()
      if (!/^\d+\.\d{6}$/.test(decimalLat)) {
        fail(`decimal degrees were not restored (${decimalLat})`)
      }
    }

    const iconFile = page.locator('input[aria-label="Файл иконки"]')
    if ((await iconFile.count()) === 0) {
      fail('custom icon file input is missing')
    } else {
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lZ9G9QAAAABJRU5ErkJggg==',
        'base64',
      )
      await iconFile.setInputFiles({
        name: 'point-icon.png',
        mimeType: 'image/png',
        buffer: png,
      })
      await page.waitForTimeout(600)
      if ((await page.locator('.map-marker-pin[data-image]').count()) === 0) {
        fail('custom icon was not applied to the map pin')
      }
      if ((await page.locator('.marker-dot.has-image img').count()) === 0) {
        fail('custom icon was not shown in the marker list')
      }
      const iconMarkers = await page.evaluate(() =>
        JSON.parse(localStorage.getItem('mappa-ui') ?? '{}')?.state?.markers,
      )
      const iconMarker = Array.isArray(iconMarkers)
        ? iconMarkers.find((marker) => marker.name === 'Тестовая метка')
        : null
      if (!iconMarker?.iconImage?.startsWith('data:image/png;base64,')) {
        fail('custom icon was not stored on the marker')
      }
    }

    const csvRows = await page
      .locator('.csv-column')
      .evaluateAll((nodes) =>
        nodes.map((node) => Math.round(node.getBoundingClientRect().top)),
      )
    if (csvRows.length > 1 && new Set(csvRows).size !== csvRows.length) {
      fail('CSV checkboxes are not on separate rows')
    }
  }
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)

  await page.locator('.topbar button[title="Настройки"]').click()
  await page.waitForTimeout(250)
  if ((await page.locator('.inspector h2').innerText()) !== 'Настройки') {
    fail('settings panel did not open')
  }
  const language = page.locator(
    '.inspector select[aria-label="Язык интерфейса"]',
  )
  if ((await language.count()) === 0) {
    fail('language selector is missing')
  } else {
    await language.selectOption('en')
    await page.waitForTimeout(250)
    const englishTitle = await page.locator('.inspector h2').innerText()
    const englishDownload = await page
      .locator('.topbar .primary-button')
      .innerText()
    const mainNav = await page.locator('.rail').getAttribute('aria-label')
    if (
      englishTitle !== 'Settings' ||
      englishDownload.trim() !== 'Download' ||
      mainNav !== 'Main sections'
    ) {
      fail(
        `English interface did not apply (${englishTitle}, ${englishDownload}, ${mainNav})`,
      )
    }
    await page
      .locator('.inspector select[aria-label="Interface language"]')
      .selectOption('ru')
    await page.waitForTimeout(250)
    if ((await page.locator('.inspector h2').innerText()) !== 'Настройки') {
      fail('Russian interface did not come back')
    }
  }
  await page.keyboard.press('Escape')

  await page.keyboard.press('Control+K')
  await page.keyboard.type('сан-франциско')
  await page.waitForTimeout(200)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1400)
  await page.selectOption('.provider-select select', 'usgs')
  await page.waitForTimeout(2500)

  const before = await page.locator('.app').getAttribute('data-theme')
  await page.keyboard.press('t')
  await page.waitForTimeout(250)
  const after = await page.locator('.app').getAttribute('data-theme')
  if (before === after) {
    fail('theme shortcut did not change the theme')
  }
  await page.waitForTimeout(400)
  const stored = await page.evaluate(() => localStorage.getItem('mappa-ui'))
  if (!stored || !stored.includes(`"theme":"${after}"`)) {
    fail('workspace was not persisted to localStorage')
  }

  await page.keyboard.press('Control+K')
  await page.keyboard.type('37.78, -122.45')
  await page.waitForTimeout(250)
  const coordinateCommand = await page
    .locator('.cmdk-item')
    .first()
    .innerText()
  if (!coordinateCommand.includes('Перейти')) {
    fail(`coordinate jump command is missing (${coordinateCommand})`)
  }
  await page.keyboard.press('Enter')
  await page.waitForTimeout(900)

  await page.locator('.rail button[title="Проекты"]').click()
  await page.waitForTimeout(250)
  if ((await page.locator('.inspector h2').innerText()) !== 'Проекты') {
    fail('projects panel did not open')
  }
  if ((await page.locator('.inspector .primary-button').count()) === 0) {
    fail('project save button is missing')
  }
  if (
    !(await page.locator('.inspector .source-hint').first().innerText()).includes(
      'не сохранён',
    )
  ) {
    fail('project path hint is missing')
  }
  await page.keyboard.press('Escape')

  await page.screenshot({ path: '/tmp/mappa-smoke.png' })

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)
  const restoredTheme = await page.locator('.app').getAttribute('data-theme')
  if (restoredTheme !== after) {
    fail(`theme was not restored after reload (${restoredTheme} != ${after})`)
  }
  if ((await page.locator('.map-marker').count()) === 0) {
    fail('markers were not restored after reload')
  }
  if ((await page.locator('.map-marker-pin[data-image]').count()) === 0) {
    fail('custom marker icon was not restored after reload')
  }
} finally {
  await browser.close()
  server?.kill()
}

if (errors.length > 0) {
  console.error('SMOKE FAILED')
  for (const error of errors) console.error(`- ${error}`)
  process.exitCode = 1
} else {
  console.log('SMOKE OK')
}
