import { useState, useRef, useEffect, useCallback } from 'react'
import './App.css'

// ─── Constants ────────────────────────────────────────────────────────────────
const NUM_COLS = 26
const NUM_ROWS = 100
const COL_WIDTH = 100
const ROW_HEIGHT = 24
const ROW_HDR_W = 46

const COLS = Array.from({ length: NUM_COLS }, (_, i) => String.fromCharCode(65 + i))

const colIdx = (col) => col.charCodeAt(0) - 65
const idxToCol = (i) => String.fromCharCode(65 + i)

const parseCellRef = (ref) => {
  const m = String(ref).match(/^([A-Z]+)(\d+)$/)
  if (!m) return null
  return { col: m[1], row: parseInt(m[2], 10) }
}

// ─── Formula Engine ───────────────────────────────────────────────────────────
const expandRange = (range) => {
  const parts = range.split(':')
  if (parts.length !== 2) return []
  const s = parseCellRef(parts[0].trim())
  const e = parseCellRef(parts[1].trim())
  if (!s || !e) return []
  const refs = []
  for (let r = s.row; r <= e.row; r++)
    for (let ci = colIdx(s.col); ci <= colIdx(e.col); ci++)
      refs.push(`${idxToCol(ci)}${r}`)
  return refs
}

const evaluate = (formula, getData, depth = 0) => {
  if (depth > 20) return '#REF!'
  if (!formula || !formula.startsWith('=')) {
    const n = parseFloat(formula)
    return formula === '' ? '' : (isNaN(n) ? formula : n)
  }

  const expr = formula.slice(1)

  const resolveRef = (ref) => {
    const raw = getData(ref.toUpperCase()) || ''
    if (raw.startsWith('=')) return evaluate(raw, getData, depth + 1)
    const n = parseFloat(raw)
    return raw === '' ? '' : (isNaN(n) ? raw : n)
  }

  const toNum = (v) => {
    if (v === '' || v === null || v === undefined) return 0
    const n = parseFloat(v)
    return isNaN(n) ? 0 : n
  }

  // Function call: NAME(args)
  const fnMatch = expr.match(/^([A-Za-z_][A-Za-z0-9_]*)\(([\s\S]*)\)$/)
  if (fnMatch) {
    const fn = fnMatch[1].toUpperCase()
    const rawArgs = fnMatch[2]

    // Split args by comma (respecting nested parens)
    const argParts = []
    let pd = 0, cur = ''
    for (const ch of rawArgs) {
      if (ch === '(') { pd++; cur += ch }
      else if (ch === ')') { pd--; cur += ch }
      else if (ch === ',' && pd === 0) { argParts.push(cur.trim()); cur = '' }
      else cur += ch
    }
    if (cur.trim()) argParts.push(cur.trim())

    let vals = []
    for (const arg of argParts) {
      if (/^[A-Z]+\d+:[A-Z]+\d+$/i.test(arg)) {
        expandRange(arg.toUpperCase()).forEach(r => vals.push(resolveRef(r)))
      } else if (/^[A-Z]+\d+$/i.test(arg)) {
        vals.push(resolveRef(arg))
      } else {
        const n = parseFloat(arg)
        vals.push(isNaN(n) ? arg.replace(/^"|"$/g, '') : n)
      }
    }

    const nums = vals.map(toNum)

    switch (fn) {
      case 'SUM':         return nums.reduce((a, b) => a + b, 0)
      case 'AVERAGE':
      case 'AVG':         return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0
      case 'MIN':         return nums.length ? Math.min(...nums) : 0
      case 'MAX':         return nums.length ? Math.max(...nums) : 0
      case 'COUNT':       return vals.filter(v => v !== '' && !isNaN(parseFloat(v))).length
      case 'COUNTA':      return vals.filter(v => v !== '' && v !== null).length
      case 'ABS':         return Math.abs(nums[0])
      case 'ROUND':       { const p = Math.pow(10, nums[1] || 0); return Math.round(nums[0] * p) / p }
      case 'FLOOR':       return Math.floor(nums[0])
      case 'CEIL':
      case 'CEILING':     return Math.ceil(nums[0])
      case 'SQRT':        return Math.sqrt(nums[0])
      case 'POWER':       return Math.pow(nums[0], nums[1])
      case 'MOD':         return nums[0] % nums[1]
      case 'IF':          return vals[0] ? (vals[1] ?? '') : (vals[2] ?? '')
      case 'AND':         return vals.every(Boolean) ? 'TRUE' : 'FALSE'
      case 'OR':          return vals.some(Boolean) ? 'TRUE' : 'FALSE'
      case 'NOT':         return !vals[0] ? 'TRUE' : 'FALSE'
      case 'CONCAT':
      case 'CONCATENATE': return vals.join('')
      case 'LEN':         return String(vals[0] ?? '').length
      case 'LEFT':        return String(vals[0] ?? '').slice(0, nums[1] || 1)
      case 'RIGHT':       return String(vals[0] ?? '').slice(-(nums[1] || 1))
      case 'MID':         return String(vals[0] ?? '').slice(nums[1] - 1, nums[1] - 1 + nums[2])
      case 'UPPER':       return String(vals[0] ?? '').toUpperCase()
      case 'LOWER':       return String(vals[0] ?? '').toLowerCase()
      case 'TRIM':        return String(vals[0] ?? '').trim()
      case 'VALUE':       return toNum(vals[0])
      default:            return '#NAME?'
    }
  }

  // Replace cell refs with values, then eval as JS expression
  const substituted = expr.replace(/[A-Z]+\d+/gi, (ref) => {
    const val = resolveRef(ref.toUpperCase())
    if (typeof val === 'string') return JSON.stringify(val)
    return val === '' ? 0 : val
  })

  try {
    // eslint-disable-next-line no-new-func
    return Function('"use strict"; return (' + substituted + ')')()
  } catch {
    return '#ERROR!'
  }
}

const fmtDisplay = (val) => {
  if (val === '' || val === null || val === undefined) return ''
  if (typeof val === 'number') {
    if (!isFinite(val)) return val > 0 ? '#DIV/0!' : '#NUM!'
    return parseFloat(val.toPrecision(12)).toString()
  }
  return String(val)
}

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [sheets, setSheets] = useState(['Sheet1', 'Sheet2', 'Sheet3'])
  const [activeSheet, setActiveSheet] = useState('Sheet1')
  // allData: { sheetName: { 'A1': { v, bold, italic, underline, align } } }
  const [allData, setAllData] = useState({ Sheet1: {}, Sheet2: {}, Sheet3: {} })

  const [selCell, setSelCell] = useState({ col: 'A', row: 1 })
  const [selEnd, setSelEnd] = useState({ col: 'A', row: 1 })
  const [isDragging, setIsDragging] = useState(false)
  const [editCell, setEditCell] = useState(null)
  const [editVal, setEditVal] = useState('')
  const [splitWidth, setSplitWidth] = useState(450)
  const [isDraggingSplitter, setIsDraggingSplitter] = useState(false)

  const containerRef = useRef(null)
  const editInputRef = useRef(null)
  const formulaBarRef = useRef(null)
  const rightPaneRef = useRef(null)
  const splitContainerRef = useRef(null)

  const selRef = `${selCell.col}${selCell.row}`
  const editRef = editCell ? `${editCell.col}${editCell.row}` : null
  const sheetData = allData[activeSheet] || {}
  const selCellData = sheetData[selRef] || {}

  const selRange = {
    minCol: Math.min(colIdx(selCell.col), colIdx(selEnd.col)),
    maxCol: Math.max(colIdx(selCell.col), colIdx(selEnd.col)),
    minRow: Math.min(selCell.row, selEnd.row),
    maxRow: Math.max(selCell.row, selEnd.row),
  }
  const isMultiSel = selCell.col !== selEnd.col || selCell.row !== selEnd.row
  const nameboxVal = isMultiSel
    ? `${idxToCol(selRange.minCol)}${selRange.minRow}:${idxToCol(selRange.maxCol)}${selRange.maxRow}`
    : selRef

  const getData = useCallback((ref) => sheetData[ref]?.v || '', [sheetData])

  const getDisplay = useCallback((ref) => {
    const raw = getData(ref)
    if (!raw) return ''
    return fmtDisplay(evaluate(raw, getData))
  }, [getData])

  const setCell = useCallback((ref, patch) => {
    setAllData(prev => ({
      ...prev,
      [activeSheet]: {
        ...prev[activeSheet],
        [ref]: { ...(prev[activeSheet]?.[ref] || {}), ...patch }
      }
    }))
  }, [activeSheet])

  const commitEdit = useCallback(() => {
    if (editRef) setCell(editRef, { v: editVal })
    setEditCell(null)
    setEditVal('')
  }, [editRef, editVal, setCell])

  const cancelEdit = useCallback(() => {
    setEditCell(null)
    setEditVal('')
  }, [])

  const beginEdit = useCallback((ref, initial = null) => {
    const parsed = parseCellRef(ref)
    if (!parsed) return
    setEditCell(parsed)
    setEditVal(initial !== null ? initial : (sheetData[ref]?.v || ''))
  }, [sheetData])

  const move = useCallback((dc, dr, extend = false) => {
    if (extend) {
      setSelEnd(prev => ({
        col: idxToCol(Math.max(0, Math.min(NUM_COLS - 1, colIdx(prev.col) + dc))),
        row: Math.max(1, Math.min(NUM_ROWS, prev.row + dr)),
      }))
    } else {
      setSelCell(prev => {
        const next = {
          col: idxToCol(Math.max(0, Math.min(NUM_COLS - 1, colIdx(prev.col) + dc))),
          row: Math.max(1, Math.min(NUM_ROWS, prev.row + dr)),
        }
        setSelEnd(next)
        return next
      })
    }
  }, [])

  const goTo = useCallback((col, row) => {
    setSelCell({ col, row })
    setSelEnd({ col, row })
    setEditCell(null)
  }, [])

  const syncScroll = useCallback((e) => {
    const other = e.currentTarget === containerRef.current ? rightPaneRef.current : containerRef.current
    if (other) other.scrollTop = e.currentTarget.scrollTop
  }, [])

  const startSplitDrag = useCallback((e) => {
    e.preventDefault()
    setIsDraggingSplitter(true)
  }, [])

  useEffect(() => {
    if (editCell && editInputRef.current) {
      const inp = editInputRef.current
      inp.focus()
      inp.setSelectionRange(inp.value.length, inp.value.length)
    }
  }, [editCell])

  useEffect(() => { containerRef.current?.focus() }, [])

  useEffect(() => {
    const onMouseUp = () => setIsDragging(false)
    window.addEventListener('mouseup', onMouseUp)
    return () => window.removeEventListener('mouseup', onMouseUp)
  }, [])

  useEffect(() => {
    if (!isDraggingSplitter) return
    const onMove = (e) => {
      if (splitContainerRef.current) {
        const rect = splitContainerRef.current.getBoundingClientRect()
        setSplitWidth(Math.max(150, Math.min(rect.width - 100, e.clientX - rect.left)))
      }
    }
    const onUp = () => setIsDraggingSplitter(false)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [isDraggingSplitter])

  // Formatting shortcuts require reading current selRef and selCellData at call time
  const toggleBold   = () => setCell(selRef, { bold: !selCellData.bold })
  const toggleItalic = () => setCell(selRef, { italic: !selCellData.italic })
  const setAlign     = (a) => setCell(selRef, { align: a })

  const handleKeyDown = (e) => {
    const meta = e.ctrlKey || e.metaKey
    if (editCell) return

    if (meta && e.key === 'b') { e.preventDefault(); toggleBold(); return }
    if (meta && e.key === 'i') { e.preventDefault(); toggleItalic(); return }
    if (meta && e.key === 'c') {
      navigator.clipboard?.writeText(getDisplay(selRef)).catch(() => {})
      return
    }

    switch (e.key) {
      case 'ArrowUp':    e.preventDefault(); move(0, -1, e.shiftKey); break
      case 'ArrowDown':  e.preventDefault(); move(0, 1, e.shiftKey); break
      case 'ArrowLeft':  e.preventDefault(); move(-1, 0, e.shiftKey); break
      case 'ArrowRight': e.preventDefault(); move(1, 0, e.shiftKey); break
      case 'Tab':        e.preventDefault(); move(e.shiftKey ? -1 : 1, 0); break
      case 'Enter':      e.preventDefault(); beginEdit(selRef); break
      case 'F2':         e.preventDefault(); beginEdit(selRef); break
      case 'Delete':
      case 'Backspace':  e.preventDefault(); setCell(selRef, { v: '' }); break
      default:
        if (e.key.length === 1 && !meta) { e.preventDefault(); beginEdit(selRef, e.key) }
    }
  }

  const handleCellKeyDown = (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); commitEdit(); move(0, 1);  containerRef.current?.focus() }
    if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); containerRef.current?.focus() }
    if (e.key === 'Tab')    { e.preventDefault(); commitEdit(); move(e.shiftKey ? -1 : 1, 0); containerRef.current?.focus() }
  }

  const fbarVal = editCell ? editVal : (sheetData[selRef]?.v || '')

  const handleFbarChange = (e) => {
    if (editCell) setEditVal(e.target.value)
    else beginEdit(selRef, e.target.value)
  }

  const handleFbarKeyDown = (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); commitEdit(); containerRef.current?.focus() }
    if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); containerRef.current?.focus() }
  }

  const addSheet = () => {
    let i = sheets.length + 1
    let name = `Sheet${i}`
    while (sheets.includes(name)) { i++; name = `Sheet${i}` }
    setSheets(p => [...p, name])
    setAllData(p => ({ ...p, [name]: {} }))
    setActiveSheet(name)
  }

  const switchSheet = (name) => {
    if (editCell) commitEdit()
    setActiveSheet(name)
    setSelCell({ col: 'A', row: 1 })
    setSelEnd({ col: 'A', row: 1 })
    setEditCell(null)
    containerRef.current?.focus()
  }

  // Status bar: show sum/avg when selected cell has a value
  const statusVal = selCellData.v
    ? selCellData.v.startsWith('=')
      ? `= ${fmtDisplay(evaluate(selCellData.v, getData))}`
      : selCellData.v
    : ''

  return (
    <div className="xls-root">
      {/* Title bar */}
      <div className="xls-titlebar">
        <ExcelIcon />
        <span className="xls-appname">Spreadsheet</span>
        <span className="xls-filename">Book1</span>
      </div>

      {/* Ribbon */}
      <div className="xls-ribbon">
        <div className="xls-ribbon-group">
          <select className="xls-select xls-font-name">
            <option>Calibri</option><option>Arial</option>
            <option>Times New Roman</option><option>Courier New</option>
          </select>
          <select className="xls-select xls-font-size">
            {[8,9,10,11,12,14,16,18,20,24].map(s => <option key={s}>{s}</option>)}
          </select>
        </div>

        <div className="xls-ribbon-sep" />

        <div className="xls-ribbon-group">
          <button className={`xls-btn bold-btn${selCellData.bold ? ' active' : ''}`} onClick={toggleBold} title="Bold (Ctrl+B)">B</button>
          <button className={`xls-btn italic-btn${selCellData.italic ? ' active' : ''}`} onClick={toggleItalic} title="Italic (Ctrl+I)">I</button>
          <button className="xls-btn underline-btn" title="Underline">U</button>
        </div>

        <div className="xls-ribbon-sep" />

        <div className="xls-ribbon-group">
          <button className={`xls-btn${selCellData.align === 'left' ? ' active' : ''}`} onClick={() => setAlign('left')} title="Align Left"><AlignLeftSVG /></button>
          <button className={`xls-btn${selCellData.align === 'center' ? ' active' : ''}`} onClick={() => setAlign('center')} title="Center"><AlignCenterSVG /></button>
          <button className={`xls-btn${selCellData.align === 'right' ? ' active' : ''}`} onClick={() => setAlign('right')} title="Align Right"><AlignRightSVG /></button>
        </div>

        <div className="xls-ribbon-sep" />

        <div className="xls-ribbon-group">
          <select className="xls-select">
            <option>General</option><option>Number</option>
            <option>Currency</option><option>Percentage</option><option>Date</option>
          </select>
        </div>
      </div>

      {/* Formula bar */}
      <div className="xls-fbar">
        <div className="xls-namebox">{nameboxVal}</div>
        <div className="xls-fx">fx</div>
        <input
          ref={formulaBarRef}
          className="xls-fbar-input"
          value={fbarVal}
          onChange={handleFbarChange}
          onKeyDown={handleFbarKeyDown}
          onFocus={() => { if (!editCell) beginEdit(selRef, sheetData[selRef]?.v || '') }}
          spellCheck={false}
        />
      </div>

      {/* Grid — split into two independently-scrolling panes */}
      <div ref={splitContainerRef} className="xls-split-container">

        {/* ── Left pane ── */}
        <div
          ref={containerRef}
          className="xls-grid-wrap"
          style={{ width: splitWidth, flexShrink: 0 }}
          tabIndex={0}
          onKeyDown={handleKeyDown}
          onScroll={syncScroll}
        >
          <table className="xls-grid">
            <colgroup>
              <col style={{ width: ROW_HDR_W }} />
              {COLS.map(col => <col key={col} style={{ width: COL_WIDTH }} />)}
            </colgroup>
            <thead>
              <tr style={{ height: ROW_HEIGHT }}>
                <th className="xls-hdr xls-corner" />
                {COLS.map(col => {
                  const ci = colIdx(col)
                  return <th key={col} className={`xls-hdr xls-col-hdr${ci >= selRange.minCol && ci <= selRange.maxCol ? ' active' : ''}`}>{col}</th>
                })}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: NUM_ROWS }, (_, i) => {
                const row = i + 1
                return (
                  <tr key={row} style={{ height: ROW_HEIGHT }}>
                    <td className={`xls-hdr xls-row-hdr${row >= selRange.minRow && row <= selRange.maxRow ? ' active' : ''}`}>{row}</td>
                    {COLS.map(col => {
                      const ref = `${col}${row}`
                      const ci = colIdx(col)
                      const isAnchor = selRef === ref
                      const isEditing = editRef === ref
                      const inRange = ci >= selRange.minCol && ci <= selRange.maxCol && row >= selRange.minRow && row <= selRange.maxRow
                      const cell = sheetData[ref] || {}
                      const raw = cell.v || ''
                      const displayVal = getDisplay(ref)
                      const isNum = raw ? raw.startsWith('=') ? typeof evaluate(raw, getData) === 'number' : !isNaN(parseFloat(raw)) && raw.trim() !== '' : false
                      const align = cell.align || (isNum ? 'right' : 'left')
                      const isTopEdge = row === selRange.minRow, isBottomEdge = row === selRange.maxRow
                      const isLeftEdge = ci === selRange.minCol, isRightEdge = ci === selRange.maxCol
                      const s = '2px solid #1e7145', h = '1px hidden'
                      const borderStyle = inRange ? { borderTop: isTopEdge ? s : h, borderBottom: isBottomEdge ? s : h, borderLeft: isLeftEdge ? s : h, borderRight: isRightEdge ? s : h } : {}
                      return (
                        <td key={ref} className={`xls-cell${inRange ? ' in-range' : ''}${isAnchor ? ' sel' : ''}`} style={borderStyle}
                          onClick={(e) => { if (editCell) commitEdit(); if (e.shiftKey) setSelEnd({ col, row }); else goTo(col, row); containerRef.current?.focus() }}
                          onMouseDown={(e) => { if (e.shiftKey) return; goTo(col, row); setIsDragging(true) }}
                          onMouseEnter={() => { if (isDragging) setSelEnd({ col, row }) }}
                          onDoubleClick={() => { goTo(col, row); beginEdit(ref) }}
                        >
                          {isEditing ? (
                            <input ref={editInputRef} className="xls-edit-input" value={editVal} onChange={e => setEditVal(e.target.value)} onKeyDown={handleCellKeyDown} spellCheck={false} />
                          ) : (
                            <div className="xls-cell-text" style={{ textAlign: align, fontWeight: cell.bold ? 'bold' : undefined, fontStyle: cell.italic ? 'italic' : undefined, textDecoration: cell.underline ? 'underline' : undefined }}>
                              {displayVal}
                            </div>
                          )}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* ── Splitter handle ── */}
        <div className="xls-split-handle" onMouseDown={startSplitDrag} />

        {/* ── Right pane (no row headers, no edit inputs) ── */}
        <div
          ref={rightPaneRef}
          className="xls-grid-wrap"
          style={{ flex: 1 }}
          tabIndex={0}
          onKeyDown={handleKeyDown}
          onScroll={syncScroll}
        >
          <table className="xls-grid">
            <colgroup>
              {COLS.map(col => <col key={col} style={{ width: COL_WIDTH }} />)}
            </colgroup>
            <thead>
              <tr style={{ height: ROW_HEIGHT }}>
                {COLS.map(col => {
                  const ci = colIdx(col)
                  return <th key={col} className={`xls-hdr xls-col-hdr${ci >= selRange.minCol && ci <= selRange.maxCol ? ' active' : ''}`}>{col}</th>
                })}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: NUM_ROWS }, (_, i) => {
                const row = i + 1
                return (
                  <tr key={row} style={{ height: ROW_HEIGHT }}>
                    {COLS.map(col => {
                      const ref = `${col}${row}`
                      const ci = colIdx(col)
                      const isAnchor = selRef === ref
                      const inRange = ci >= selRange.minCol && ci <= selRange.maxCol && row >= selRange.minRow && row <= selRange.maxRow
                      const cell = sheetData[ref] || {}
                      const raw = cell.v || ''
                      const displayVal = getDisplay(ref)
                      const isNum = raw ? raw.startsWith('=') ? typeof evaluate(raw, getData) === 'number' : !isNaN(parseFloat(raw)) && raw.trim() !== '' : false
                      const align = cell.align || (isNum ? 'right' : 'left')
                      const isTopEdge = row === selRange.minRow, isBottomEdge = row === selRange.maxRow
                      const isLeftEdge = ci === selRange.minCol, isRightEdge = ci === selRange.maxCol
                      const s = '2px solid #1e7145', h = '1px hidden'
                      const borderStyle = inRange ? { borderTop: isTopEdge ? s : h, borderBottom: isBottomEdge ? s : h, borderLeft: isLeftEdge ? s : h, borderRight: isRightEdge ? s : h } : {}
                      return (
                        <td key={ref} className={`xls-cell${inRange ? ' in-range' : ''}${isAnchor ? ' sel' : ''}`} style={borderStyle}
                          onClick={(e) => { if (editCell) commitEdit(); if (e.shiftKey) setSelEnd({ col, row }); else goTo(col, row); rightPaneRef.current?.focus() }}
                          onMouseDown={(e) => { if (e.shiftKey) return; goTo(col, row); setIsDragging(true) }}
                          onMouseEnter={() => { if (isDragging) setSelEnd({ col, row }) }}
                          onDoubleClick={() => { goTo(col, row); beginEdit(ref); containerRef.current?.focus() }}
                        >
                          <div className="xls-cell-text" style={{ textAlign: align, fontWeight: cell.bold ? 'bold' : undefined, fontStyle: cell.italic ? 'italic' : undefined, textDecoration: cell.underline ? 'underline' : undefined }}>
                            {displayVal}
                          </div>
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

      </div>

      {/* Sheet tabs + status bar */}
      <div className="xls-statusbar">
        <button className="xls-tab-add" onClick={addSheet} title="New sheet">+</button>
        <div className="xls-tab-list">
          {sheets.map(name => (
            <button
              key={name}
              className={`xls-tab${activeSheet === name ? ' active' : ''}`}
              onClick={() => switchSheet(name)}
            >{name}</button>
          ))}
        </div>
        <div className="xls-status-right">{statusVal}</div>
      </div>
    </div>
  )
}

// ─── SVG Icons ────────────────────────────────────────────────────────────────
function ExcelIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <rect width="18" height="18" rx="2" fill="#1D6638" />
      <path d="M4.5 4.5h4L10 8.5 11.5 4.5H13.5l-2.8 4.5 2.8 4.5H11.5L10 9.5 8.5 13.5H6.5L9.3 9 6.5 4.5z" fill="white" />
    </svg>
  )
}
function AlignLeftSVG() {
  return <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><rect x="1" y="2" width="12" height="1.5"/><rect x="1" y="5.5" width="7" height="1.5"/><rect x="1" y="9" width="12" height="1.5"/><rect x="1" y="12.5" width="7" height="1.5"/></svg>
}
function AlignCenterSVG() {
  return <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><rect x="1" y="2" width="12" height="1.5"/><rect x="3.5" y="5.5" width="7" height="1.5"/><rect x="1" y="9" width="12" height="1.5"/><rect x="3.5" y="12.5" width="7" height="1.5"/></svg>
}
function AlignRightSVG() {
  return <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><rect x="1" y="2" width="12" height="1.5"/><rect x="6" y="5.5" width="7" height="1.5"/><rect x="1" y="9" width="12" height="1.5"/><rect x="6" y="12.5" width="7" height="1.5"/></svg>
}
