import { useEffect, useMemo, useRef, useState } from 'react'
import { Fragment } from 'react'
import {
  ComposedChart,
  Line,
  ResponsiveContainer,
  Scatter,
  CartesianGrid,
  XAxis,
  YAxis,
} from 'recharts'
import JSZip from 'jszip'
import { saveAs } from 'file-saver'
import { Download, FileDown, RotateCcw } from 'lucide-react'
import './App.css'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000'
const TUNNEL_MANAGER_URL = import.meta.env.VITE_TUNNEL_MANAGER_URL || 'http://localhost:4100'
const EXPERIMENT_LIST_RAW =
  import.meta.env.VITE_EXPERIMENT_LIST || import.meta.env.EXPERIMENT_LIST || ''

const STAGE_ONE_COLOR = '#1f5fff'
const STAGE_TWO_COLOR = '#f68026'
const NODE_HIT_RADIUS_PX = 24
const TOOLTIP_OFFSET_PX = 12
const TOOLTIP_MARGIN_PX = 8
const TOOLTIP_FALLBACK_WIDTH_PX = 240
const TOOLTIP_FALLBACK_HEIGHT_PX = 132

const REQ_MIN_KEYS = [
  'REQ_MIN',
  'req_min',
  'Requests sent per minute',
  'requests_sent_per_minute',
  'requests_per_minute',
  'RPM',
  'rpm',
]

const EVALUATION_KEYS = ['EVALUATION', 'Evaluation', 'evaluation', 'evaluated', 'is_eval_true']
const DATE_KEYS = ['Date', 'date', 'Timestamp', 'timestamp', 'created_at']
const SUCCESS_KEYS = [
  'SUCCESS_RATE',
  'Success rate',
  'success_rate',
  'successRate',
  'pass_rate',
]
const STAGE_KEYS = ['STAGE', 'Stage', 'stage', 'Pipeline stage', 'pipeline_stage']
const FINISHED_KEYS = ['FINISHED', 'Finished', 'finished', 'IS_FINISHED', 'is_finished']
const LARGEST_TRUE_KEYS = [
  'LARGEST_TRUE',
  'Largest true',
  'largest_true',
  'largestTrue',
  'CURRENT_LARGEST_TRUE',
]

function getFieldValue(row, keys) {
  if (!row) {
    return null
  }

  for (const key of keys) {
    const value = row[key]
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).trim()
    }
  }

  return null
}

function parseNumber(value) {
  if (value === null || value === undefined) {
    return null
  }

  const cleaned = String(value).replace('%', '').replace(',', '.').trim()
  const numeric = Number(cleaned)
  return Number.isFinite(numeric) ? numeric : null
}

function parseBoolean(value) {
  if (value === null || value === undefined) {
    return false
  }

  const normalized = String(value).trim().toLowerCase()
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'pass'
}

function sortIterationsChronologically(iterations) {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
  return [...iterations].sort((a, b) => collator.compare(a, b))
}

function detectStage(iteration, row) {
  const stageFromRow = getFieldValue(row, STAGE_KEYS)

  if (stageFromRow) {
    if (/(^|\s|_)1($|\s|_)/i.test(stageFromRow) || /stage\s*1/i.test(stageFromRow)) {
      return 1
    }
    if (/(^|\s|_)2($|\s|_)/i.test(stageFromRow) || /stage\s*2/i.test(stageFromRow)) {
      return 2
    }
  }

  if (/stage[_\s-]*1|(^|[_\s-])s1([_\s-]|$)/i.test(iteration)) {
    return 1
  }
  if (/stage[_\s-]*2|(^|[_\s-])s2([_\s-]|$)/i.test(iteration)) {
    return 2
  }

  return 1
}

function formatSuccessRate(value) {
  const numeric = parseNumber(value)
  if (numeric === null) {
    return value || 'Unknown'
  }

  return `${numeric}%`
}

function buildApiUrl(pathname) {
  return `${API_BASE_URL}${pathname}`
}

function buildTunnelUrl(pathname) {
  return `${TUNNEL_MANAGER_URL}${pathname}`
}

function parseExperimentPair(experimentName) {
  if (!experimentName) {
    return null
  }

  const separator = experimentName.includes('_') ? '_' : experimentName.includes(':') ? ':' : null
  if (!separator) {
    return null
  }

  const [inputRange, outputRange] = experimentName.split(separator)
  if (!inputRange || !outputRange) {
    return null
  }

  return {
    inputRange,
    outputRange,
  }
}

function intervalStart(interval) {
  if (!interval) {
    return Number.MAX_SAFE_INTEGER
  }

  const [startToken] = interval.split('-')
  const numeric = Number(startToken)
  return Number.isFinite(numeric) ? numeric : Number.MAX_SAFE_INTEGER
}

function formatIntervalLabel(interval) {
  if (!interval) {
    return ''
  }

  const [start, end] = interval.split('-')
  const displayStart = start === '10000000' ? '∞' : start
  const displayEnd = end === '10000000' ? '∞' : end

  if (!displayStart || !displayEnd) {
    return interval.replace('-', '/')
  }

  return `${displayStart}/${displayEnd}`
}

function buildConfiguredExperimentList(rawList) {
  if (!rawList) {
    return []
  }

  const normalized = rawList
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const pair = parseExperimentPair(item)
      if (!pair) {
        return null
      }

      return `${pair.inputRange}_${pair.outputRange}`
    })
    .filter(Boolean)

  return [...new Set(normalized)]
}

function getHeatmapColor(value, min, max) {
  if (!Number.isFinite(value)) {
    return '#ffffff'
  }

  const t = max > min ? (value - min) / (max - min) : 1
  const clamped = Math.min(Math.max(t, 0), 1)

  const start = { r: 239, g: 239, b: 197 }
  const end = { r: 24, g: 48, b: 132 }

  const r = Math.round(start.r + (end.r - start.r) * clamped)
  const g = Math.round(start.g + (end.g - start.g) * clamped)
  const b = Math.round(start.b + (end.b - start.b) * clamped)

  return `rgb(${r}, ${g}, ${b})`
}

async function fetchJson(pathname) {
  const response = await fetch(buildApiUrl(pathname))
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${pathname}`)
  }
  return response.json()
}

async function fetchExperimentIterations(experimentName) {
  const response = await fetch(
    buildApiUrl(`/api/experiments/${encodeURIComponent(experimentName)}/iterations`),
  )

  if (!response.ok) {
    return []
  }

  const data = await response.json()
  return sortIterationsChronologically(data.iterations || [])
}

function CustomNode({ cx, cy, payload, onHover, onHoverEnd, onSelect }) {
  if (!payload || cx === undefined || cy === undefined) {
    return null
  }

  const isPositive = payload.evaluation
  const interactionProps = {
    onMouseEnter: () => onHover?.(payload, { x: cx, y: cy }),
    onMouseMove: () => onHover?.(payload, { x: cx, y: cy }),
    onMouseLeave: () => onHoverEnd?.(),
    onClick: () => onSelect?.(payload.iteration),
  }

  const color = payload.stage === 2 ? STAGE_TWO_COLOR : STAGE_ONE_COLOR

  if (isPositive) {
    return (
      <g className="chart-node" {...interactionProps}>
        <circle cx={cx} cy={cy} r={NODE_HIT_RADIUS_PX} className="chart-node-hitarea" />
        <circle cx={cx} cy={cy} r={6} fill={color} stroke="#ffffff" strokeWidth={1.6} className="chart-node-mark" />
      </g>
    )
  }

  const size = 7

  return (
    <g className="chart-node chart-node-false" {...interactionProps}>
      <circle cx={cx} cy={cy} r={NODE_HIT_RADIUS_PX} className="chart-node-hitarea" />
      <line
        x1={cx - size}
        y1={cy - size}
        x2={cx + size}
        y2={cy + size}
        stroke={color}
        strokeWidth={2.9}
        strokeLinecap="round"
        className="chart-node-mark"
      />
      <line
        x1={cx - size}
        y1={cy + size}
        x2={cx + size}
        y2={cy - size}
        stroke={color}
        strokeWidth={2.9}
        strokeLinecap="round"
        className="chart-node-mark"
      />
    </g>
  )
}

function IterationSummary({ point }) {
  if (!point) {
    return null
  }

  return (
    <div className="custom-tooltip">
      <p>{point.dateLabel}</p>
      <p>Iteration: {point.index}</p>
      <p>REQ_MIN: {point.reqMin ?? 'N/A'}</p>
      <p>Stage: {point.stage}</p>
      <p>Evaluation: {String(point.evaluation).toUpperCase()}</p>
      <p>Success: {point.successLabel}</p>
    </div>
  )
}

function App() {
  const chartWrapperRef = useRef(null)
  const [headerData, setHeaderData] = useState({ llm: 'Loading...', gpu: 'Loading...' })
  const [experiments, setExperiments] = useState([])
  const [selectedExperiment, setSelectedExperiment] = useState('')
  const [iterationData, setIterationData] = useState([])
  const [selectedIteration, setSelectedIteration] = useState('')
  const [selectedIterationRows, setSelectedIterationRows] = useState([])
  const [hoveredSummary, setHoveredSummary] = useState(null)
  const [loadingIterations, setLoadingIterations] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [busyExperimentDownload, setBusyExperimentDownload] = useState('')
  const [experimentStatuses, setExperimentStatuses] = useState({})
  const [loadingMatrixStatus, setLoadingMatrixStatus] = useState(false)
  const [tunnelInfo, setTunnelInfo] = useState({
    loading: true,
    reachable: false,
    running: false,
    apiOk: false,
    apiMessage: 'Checking...',
    config: null,
  })
  const [tunnelBusy, setTunnelBusy] = useState(false)

  useEffect(() => {
    let isMounted = true

    async function refreshTunnelStatus() {
      try {
        const response = await fetch(buildTunnelUrl('/status'))
        if (!response.ok) {
          throw new Error('Tunnel manager status failed.')
        }

        const data = await response.json()
        if (!isMounted) {
          return
        }

        setTunnelInfo({
          loading: false,
          reachable: true,
          running: Boolean(data.running),
          apiOk: Boolean(data.apiHealth?.ok),
          apiMessage: data.apiHealth?.message || 'Unknown status',
          config: data.config || null,
        })
      } catch {
        if (!isMounted) {
          return
        }

        setTunnelInfo({
          loading: false,
          reachable: false,
          running: false,
          apiOk: false,
          apiMessage: 'Tunnel manager is offline.',
          config: null,
        })
      }
    }

    refreshTunnelStatus()
    const timer = setInterval(refreshTunnelStatus, 8000)

    return () => {
      isMounted = false
      clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    async function loadHeader() {
      try {
        const [llmResponse, gpuResponse] = await Promise.all([
          fetchJson('/api/llm-name'),
          fetchJson('/api/gpu-used'),
        ])

        setHeaderData({
          llm: llmResponse.llmName || 'Unknown model',
          gpu: gpuResponse.gpuUsed || 'Unknown GPU',
        })
      } catch {
        setHeaderData({ llm: 'Unavailable', gpu: 'Unavailable' })
      }
    }

    async function loadExperiments() {
      try {
        const data = await fetchJson('/api/experiments')
        const apiList = data.experiments || []
        const configuredList = buildConfiguredExperimentList(EXPERIMENT_LIST_RAW)
        const matrixList = configuredList.length > 0 ? configuredList : apiList

        setExperiments(matrixList)
        if (matrixList.length > 0) {
          setSelectedExperiment(matrixList[0])
        }
      } catch {
        setErrorMessage('Unable to load experiments from API.')
      }
    }

    loadHeader()
    loadExperiments()
  }, [])

  useEffect(() => {
    if (experiments.length === 0) {
      setExperimentStatuses({})
      return
    }

    let isCancelled = false

    async function loadExperimentStatuses() {
      setLoadingMatrixStatus(true)

      try {
        const statuses = await Promise.all(
          experiments.map(async (experiment) => {
            try {
              const iterations = await fetchExperimentIterations(experiment)
              if (iterations.length === 0) {
                return [
                  experiment,
                  {
                    hasResults: false,
                    finished: false,
                    largestTrue: null,
                  },
                ]
              }

              const latestIteration = iterations[iterations.length - 1]
              const csv = await fetchJson(
                `/api/experiments/${encodeURIComponent(experiment)}/iterations/${encodeURIComponent(latestIteration)}/results.csv`,
              )

              const rows = csv.rows || []
              const latestRow = rows.length > 0 ? rows[rows.length - 1] : null
              if (!latestRow) {
                return [
                  experiment,
                  {
                    hasResults: false,
                    finished: false,
                    largestTrue: null,
                  },
                ]
              }

              const finished = parseBoolean(getFieldValue(latestRow, FINISHED_KEYS))
              const largestTrue = parseNumber(getFieldValue(latestRow, LARGEST_TRUE_KEYS))

              return [
                experiment,
                {
                  hasResults: true,
                  finished,
                  largestTrue,
                },
              ]
            } catch {
              return [
                experiment,
                {
                  hasResults: false,
                  finished: false,
                  largestTrue: null,
                },
              ]
            }
          }),
        )

        if (!isCancelled) {
          setExperimentStatuses(Object.fromEntries(statuses))
        }
      } finally {
        if (!isCancelled) {
          setLoadingMatrixStatus(false)
        }
      }
    }

    loadExperimentStatuses()

    return () => {
      isCancelled = true
    }
  }, [experiments])

  useEffect(() => {
    if (!selectedExperiment) {
      return
    }

    async function loadExperimentData() {
      setLoadingIterations(true)
      setErrorMessage('')

      try {
        const iterations = await fetchExperimentIterations(selectedExperiment)

        if (iterations.length === 0) {
          setIterationData([])
          setSelectedIteration('')
          setSelectedIterationRows([])
          return
        }

        const points = await Promise.all(
          iterations.map(async (iterationName, index) => {
            const csv = await fetchJson(
              `/api/experiments/${encodeURIComponent(selectedExperiment)}/iterations/${encodeURIComponent(iterationName)}/results.csv`,
            )

            const firstRow = csv.rows?.[0] || {}
            const reqMinRaw = getFieldValue(firstRow, REQ_MIN_KEYS)
            const evaluationRaw = getFieldValue(firstRow, EVALUATION_KEYS)
            const dateRaw = getFieldValue(firstRow, DATE_KEYS) || iterationName
            const successRaw = getFieldValue(firstRow, SUCCESS_KEYS)
            const stage = detectStage(iterationName, firstRow)
            const reqMin = parseNumber(reqMinRaw)
            const evaluation = parseBoolean(evaluationRaw)

            return {
              index: index + 1,
              iteration: iterationName,
              dateLabel: dateRaw,
              reqMin,
              stage,
              evaluation,
              successLabel: formatSuccessRate(successRaw),
              stage1ReqMin: stage === 1 ? reqMin : null,
              stage2ReqMin: stage === 2 ? reqMin : null,
              rows: csv.rows || [],
            }
          }),
        )

        setIterationData(points)
        if (points.length > 0) {
          setSelectedIteration(points[0].iteration)
          setSelectedIterationRows(points[0].rows)
        } else {
          setSelectedIteration('')
          setSelectedIterationRows([])
        }
      } catch {
        setIterationData([])
        setSelectedIteration('')
        setSelectedIterationRows([])
        setErrorMessage(`Unable to load iteration data for ${selectedExperiment}.`)
      } finally {
        setLoadingIterations(false)
      }
    }

    loadExperimentData()
  }, [selectedExperiment])

  const selectedPoint = useMemo(
    () => iterationData.find((point) => point.iteration === selectedIteration) || null,
    [iterationData, selectedIteration],
  )

  const matrixModel = useMemo(() => {
    const pairEntries = experiments
      .map((experiment) => {
        const parsed = parseExperimentPair(experiment)
        if (!parsed) {
          return null
        }

        return {
          experiment,
          inputRange: parsed.inputRange,
          outputRange: parsed.outputRange,
        }
      })
      .filter(Boolean)

    const inputRanges = [...new Set(pairEntries.map((entry) => entry.inputRange))].sort(
      (a, b) => intervalStart(a) - intervalStart(b),
    )
    const outputRanges = [...new Set(pairEntries.map((entry) => entry.outputRange))].sort(
      (a, b) => intervalStart(a) - intervalStart(b),
    )

    const pairMap = pairEntries.reduce((accumulator, entry) => {
      accumulator[`${entry.inputRange}__${entry.outputRange}`] = entry.experiment
      return accumulator
    }, {})

    return {
      inputRanges,
      outputRanges,
      pairMap,
    }
  }, [experiments])

  const finishedLargestTrueValues = useMemo(
    () =>
      Object.values(experimentStatuses)
        .filter((status) => status?.hasResults && status?.finished && Number.isFinite(status?.largestTrue))
        .map((status) => status.largestTrue),
    [experimentStatuses],
  )

  const heatScale = useMemo(() => {
    if (finishedLargestTrueValues.length === 0) {
      return { min: 0, max: 1 }
    }

    return {
      min: Math.min(...finishedLargestTrueValues),
      max: Math.max(...finishedLargestTrueValues),
    }
  }, [finishedLargestTrueValues])

  const displayedInputRanges = useMemo(
    () => [...matrixModel.inputRanges].reverse(),
    [matrixModel.inputRanges],
  )

  const tableColumns = useMemo(() => {
    const columns = new Set()
    selectedIterationRows.forEach((row) => {
      Object.keys(row).forEach((key) => columns.add(key))
    })
    return [...columns]
  }, [selectedIterationRows])

  function handleSelectPoint(iteration) {
    const found = iterationData.find((point) => point.iteration === iteration)
    if (!found) {
      return
    }

    setSelectedIteration(found.iteration)
    setSelectedIterationRows(found.rows)
  }

  function handlePointHover(point, position) {
    if (!point || !position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) {
      return
    }

    const wrapperRect = chartWrapperRef.current?.getBoundingClientRect()
    const wrapperWidth = wrapperRect?.width || 0
    const wrapperHeight = wrapperRect?.height || 0

    const rawLeft = position.x - TOOLTIP_FALLBACK_WIDTH_PX - TOOLTIP_OFFSET_PX
    const rawTop = position.y - TOOLTIP_FALLBACK_HEIGHT_PX / 2

    const maxLeft = Math.max(TOOLTIP_MARGIN_PX, wrapperWidth - TOOLTIP_FALLBACK_WIDTH_PX - TOOLTIP_MARGIN_PX)
    const maxTop = Math.max(TOOLTIP_MARGIN_PX, wrapperHeight - TOOLTIP_FALLBACK_HEIGHT_PX - TOOLTIP_MARGIN_PX)

    const clampedLeft = wrapperWidth
      ? Math.min(Math.max(rawLeft, TOOLTIP_MARGIN_PX), maxLeft)
      : rawLeft
    const clampedTop = wrapperHeight
      ? Math.min(Math.max(rawTop, TOOLTIP_MARGIN_PX), maxTop)
      : rawTop

    setHoveredSummary({
      point,
      position: {
        x: clampedLeft,
        y: clampedTop,
      },
    })
  }

  function handlePointHoverEnd() {
    setHoveredSummary(null)
  }

  function handleChartMouseLeave() {
    setHoveredSummary(null)
  }

  async function downloadIterationFile(fileType) {
    if (!selectedExperiment || !selectedIteration) {
      return
    }

    if (
      fileType === 'results.json' &&
      !window.confirm('This download may take a long time. Do you want to continue?')
    ) {
      return
    }

    try {
      const endpoint = `/api/experiments/${encodeURIComponent(selectedExperiment)}/iterations/${encodeURIComponent(selectedIteration)}/download/${fileType}`
      const response = await fetch(buildApiUrl(endpoint))
      if (!response.ok) {
        throw new Error('Download failed.')
      }

      const blob = await response.blob()
      saveAs(blob, `${selectedExperiment}-${selectedIteration}-${fileType}`)
    } catch {
      setErrorMessage(`Unable to download ${fileType} for ${selectedIteration}.`)
    }
  }

  async function downloadExperimentCsvZip(experiment) {
    setBusyExperimentDownload(experiment)
    setErrorMessage('')

    try {
      const iterationResponse = await fetchJson(`/api/experiments/${encodeURIComponent(experiment)}/iterations`)
      const iterations = iterationResponse.iterations || []
      const zip = new JSZip()

      for (const iterationName of iterations) {
        const endpoint = `/api/experiments/${encodeURIComponent(experiment)}/iterations/${encodeURIComponent(iterationName)}/download/results.csv`
        const response = await fetch(buildApiUrl(endpoint))
        if (!response.ok) {
          continue
        }

        const csvBlob = await response.blob()
        zip.file(`${experiment}/${iterationName}/results.csv`, csvBlob)
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' })
      saveAs(zipBlob, `${experiment}-iterations-results-csv.zip`)
    } catch {
      setErrorMessage(`Unable to build zip for ${experiment}.`)
    } finally {
      setBusyExperimentDownload('')
    }
  }

  async function restartTunnel() {
    setTunnelBusy(true)

    try {
      const response = await fetch(buildTunnelUrl('/restart'), {
        method: 'POST',
      })

      if (!response.ok) {
        throw new Error('Restart failed.')
      }
    } catch {
      setErrorMessage('Unable to restart SSH tunnel from dashboard.')
    } finally {
      setTunnelBusy(false)
    }
  }

  const tunnelState = useMemo(() => {
    if (tunnelInfo.loading) {
      return { label: 'Checking tunnel...', tone: 'neutral' }
    }

    if (!tunnelInfo.reachable) {
      return { label: 'Tunnel manager offline', tone: 'down' }
    }

    if (tunnelInfo.running && tunnelInfo.apiOk) {
      return { label: 'Tunnel active', tone: 'ok' }
    }

    if (tunnelInfo.running && !tunnelInfo.apiOk) {
      return { label: 'Tunnel running, API unreachable', tone: 'warn' }
    }

    return { label: 'Tunnel stopped', tone: 'down' }
  }, [tunnelInfo])

  return (
    <div className="dashboard-shell">
      <header className="dashboard-header">
        <h1>{headerData.llm}</h1>
        <p>{headerData.gpu}</p>
      </header>

      <section className="tunnel-strip" data-tone={tunnelState.tone}>
        <div>
          <strong>{tunnelState.label}</strong>
          <p>
            {tunnelInfo.config
              ? `Forward ${tunnelInfo.config.localBind}:${tunnelInfo.config.localPort} to ${tunnelInfo.config.remoteHost}:${tunnelInfo.config.remotePort}`
              : tunnelInfo.apiMessage}
          </p>
        </div>
        <button
          type="button"
          className="tunnel-refresh"
          onClick={restartTunnel}
          disabled={tunnelBusy}
          title="Restart SSH tunnel"
        >
          <RotateCcw size={16} />
          {tunnelBusy ? 'Restarting...' : 'Restart tunnel'}
        </button>
      </section>

      {errorMessage && <div className="error-banner">{errorMessage}</div>}

      <main className="dashboard-main">
        <aside className="experiment-panel">
          <div className="experiment-panel-header">
            <h2>Experiments Matrix</h2>
            <button
              type="button"
              className="icon-button"
              onClick={() => selectedExperiment && downloadExperimentCsvZip(selectedExperiment)}
              title="Download selected experiment CSV zip"
              aria-label="Download selected experiment zip"
              disabled={!selectedExperiment || busyExperimentDownload === selectedExperiment}
            >
              <Download size={16} />
            </button>
          </div>
          <p className="matrix-helper">Rows: input intervals. Columns: output intervals.</p>

          {matrixModel.inputRanges.length === 0 || matrixModel.outputRanges.length === 0 ? (
            <p className="placeholder">No interval-pair experiments found.</p>
          ) : (
            <div className="experiment-matrix-wrapper">
              <div
                className="experiment-matrix"
                style={{
                  gridTemplateColumns: `minmax(68px, 1.2fr) repeat(${matrixModel.outputRanges.length}, minmax(0, 1fr))`,
                }}
              >
                {displayedInputRanges.map((inputRange) => (
                  <Fragment key={`matrix-row-${inputRange}`}>
                    <div className="matrix-header matrix-row-header" key={`row-${inputRange}`}>
                      {formatIntervalLabel(inputRange)}
                    </div>
                    {matrixModel.outputRanges.map((outputRange) => {
                      const pairKey = `${inputRange}__${outputRange}`
                      const experiment = matrixModel.pairMap[pairKey] || null
                      const status = experiment ? experimentStatuses[experiment] : null
                      const isSelected = experiment === selectedExperiment
                      const hasValue = Number.isFinite(status?.largestTrue)

                      let backgroundColor = '#ffffff'
                      let text = ''
                      let tone = 'empty'

                      if (status?.hasResults && !status?.finished) {
                        backgroundColor = '#ffd1e3'
                        text = hasValue ? String(Math.round(status.largestTrue)) : ''
                        tone = 'pending'
                      } else if (status?.hasResults && status?.finished) {
                        backgroundColor = getHeatmapColor(status.largestTrue, heatScale.min, heatScale.max)
                        text = hasValue ? String(Math.round(status.largestTrue)) : ''
                        tone = 'finished'
                      }

                      return (
                        <button
                          key={`${inputRange}-${outputRange}`}
                          type="button"
                          className={`matrix-cell ${isSelected ? 'is-selected' : ''}`}
                          data-tone={tone}
                          style={{ backgroundColor }}
                          onClick={() => experiment && setSelectedExperiment(experiment)}
                          disabled={!experiment}
                          title={experiment || 'No experiment mapped for this pair'}
                        >
                          <span>{text}</span>
                        </button>
                      )
                    })}
                  </Fragment>
                ))}

                <div className="matrix-corner matrix-footer-corner" />
                {matrixModel.outputRanges.map((outputRange) => (
                  <div className="matrix-header matrix-col-footer" key={`footer-${outputRange}`}>
                    {formatIntervalLabel(outputRange)}
                  </div>
                ))}
              </div>
            </div>
          )}
          {loadingMatrixStatus && <p className="matrix-loading">Updating matrix status...</p>}
        </aside>

        <section className="chart-panel">
          <div className="chart-header">
            <h2>{selectedExperiment || 'No experiment selected'}</h2>
            <div className="chart-legend">
              <span><i className="dot stage-1" />Stage 1</span>
              <span><i className="dot stage-2" />Stage 2</span>
            </div>
          </div>

          <div className="chart-wrapper" ref={chartWrapperRef}>
            {loadingIterations ? (
              <p className="placeholder">Loading iteration metrics...</p>
            ) : iterationData.length === 0 ? (
              <p className="placeholder">No iterations available for this experiment.</p>
            ) : (
              <>
                <ResponsiveContainer width="100%" height={380}>
                  <ComposedChart
                    data={iterationData}
                    margin={{ top: 16, right: 16, left: 8, bottom: 8 }}
                    onMouseLeave={handleChartMouseLeave}
                  >
                    <CartesianGrid strokeDasharray="4 6" stroke="#d2dce5" />
                    <XAxis
                      type="number"
                      dataKey="index"
                      domain={[1, 'dataMax']}
                      label={{ value: 'Iteration Number', position: 'insideBottom', offset: -4 }}
                      allowDecimals={false}
                    />
                    <YAxis label={{ value: 'Requests/minute', angle: -90, position: 'insideLeft' }} />
                    <Line
                      type="linear"
                      dataKey="stage1ReqMin"
                      stroke={STAGE_ONE_COLOR}
                      strokeWidth={2.6}
                      connectNulls
                      dot={false}
                    />
                    <Line
                      type="linear"
                      dataKey="stage2ReqMin"
                      stroke={STAGE_TWO_COLOR}
                      strokeWidth={2.6}
                      connectNulls
                      dot={false}
                    />
                    <Scatter
                      dataKey="reqMin"
                      data={iterationData}
                      shape={(props) => (
                        <CustomNode
                          {...props}
                          onHover={handlePointHover}
                          onHoverEnd={handlePointHoverEnd}
                          onSelect={handleSelectPoint}
                        />
                      )}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
                {hoveredSummary && (
                  <div
                    className="custom-tooltip-overlay"
                    style={{ left: `${hoveredSummary.position.x}px`, top: `${hoveredSummary.position.y}px` }}
                  >
                    <IterationSummary point={hoveredSummary.point} />
                  </div>
                )}
              </>
            )}
          </div>
        </section>
      </main>

      <section className="detail-panel">
        <div className="detail-header">
          <div>
            <h2>Iteration Detail</h2>
            <p>{selectedPoint ? `${selectedPoint.iteration} - ${selectedPoint.dateLabel}` : 'Select a point in the chart'}</p>
          </div>
          <div className="detail-actions">
            <button
              type="button"
              onClick={() => downloadIterationFile('results.csv')}
              disabled={!selectedIteration}
              className="icon-button"
              title="Download results.csv"
            >
              <FileDown size={16} />
            </button>
            <button
              type="button"
              onClick={() => downloadIterationFile('results.json')}
              disabled={!selectedIteration}
              className="icon-button"
              title="Download results.json"
            >
              <Download size={16} />
            </button>
          </div>
        </div>

        <div className="table-wrapper">
          {tableColumns.length === 0 ? (
            <p className="placeholder">Click an iteration node to inspect all results.csv fields.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  {tableColumns.map((column) => (
                    <th key={column}>{column}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {selectedIterationRows.map((row, rowIndex) => (
                  <tr key={`${rowIndex}-${selectedIteration}`}>
                    {tableColumns.map((column) => (
                      <td key={`${rowIndex}-${column}`}>{row[column] ?? ''}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  )
}

export default App
