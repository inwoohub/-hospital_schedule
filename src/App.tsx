import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { getHolidayPreset } from '@hyunbinseo/holidays-kr'
import './App.css'
import {
  DEFAULT_SCHEDULING_RULES,
  RULE_LABELS,
  normalizeSchedulingRules,
  validateSchedule,
  type FixedAssignments,
  type SchedulingRules,
  type WorkShift,
} from './scheduler-core'

type Shift = 'D' | 'E' | 'N' | 'S' | 'O' | 'V'
type Role = 'senior' | 'junior'
export type Staff = { id: string; name: string; role: Role; vacations: number[] }
export type Schedule = Record<string, Record<number, Shift>>
type HolidayPreset = Readonly<Record<string, readonly string[]>>
type SchedulingFailure = {
  message: string
  issues: string[]
  failureKind: 'infeasible' | 'unknown' | 'error'
  relaxation: {
    rules: Array<keyof SchedulingRules>
    title: string
    reason: string
  } | null
  suspectedRules: Array<{
    rule: keyof SchedulingRules
    title: string
  }>
}

const shiftInfo: Record<Shift, { label: string; short: string }> = {
  D: { label: '데이', short: 'D' },
  E: { label: '이브닝', short: 'E' },
  N: { label: '나이트', short: 'N' },
  S: { label: 'S/P', short: 'S/P' },
  O: { label: '오프', short: 'O' },
  V: { label: '휴가', short: 'V' },
}

const defaultStaff: Staff[] = []
const legacySampleIds = new Set(['1', '2', '3', '4', '5', '6'])

const daysInMonth = (year: number, month: number) =>
  new Date(year, month + 1, 0).getDate()

const dateKey = (year: number, month: number, day: number) =>
  `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`

const makeAutomaticSpecialNeeds = (year: number, month: number, holidays: HolidayPreset) =>
  Object.fromEntries(
    Array.from({ length: daysInMonth(year, month) }, (_, index) => {
      const day = index + 1
      const weekday = new Date(year, month, day).getDay()
      const isPublicHoliday = dateKey(year, month, day) in holidays
      const count = isPublicHoliday || weekday === 0 ? 2 : weekday === 6 ? 1 : 0
      return [day, count]
    }).filter(([, count]) => count > 0),
  ) as Record<number, number>

const isWork = (shift?: Shift) => shift === 'D' || shift === 'E' || shift === 'N' || shift === 'S'
const formatDuration = (seconds: number) => seconds < 60
  ? `${seconds}초`
  : `${Math.floor(seconds / 60)}분 ${seconds % 60}초`

const requiredRuleLabels = [
  'D/E/N 각 2명',
  'D/E/N 사수 최소 1명',
  '휴가 지정일 반영',
  'S/P 토 1명 · 일/공휴일 2명',
  'S/P 사수 필수',
]

const optionalRuleKeys = (Object.keys(RULE_LABELS) as Array<keyof SchedulingRules>)
  .filter((rule) => rule !== 'rolePairing')

type FixedAssignmentsByMonth = Record<string, FixedAssignments>

const loadFixedAssignments = (): FixedAssignmentsByMonth => {
  try {
    const saved = localStorage.getItem('nurse-scheduler-fixed-assignments')
    return saved ? JSON.parse(saved) as FixedAssignmentsByMonth : {}
  } catch {
    return {}
  }
}

function App() {
  const today = new Date()
  const [year, setYear] = useState(today.getFullYear())
  const [month, setMonth] = useState(today.getMonth())
  const [staff, setStaff] = useState<Staff[]>(() => {
    const saved = localStorage.getItem('nurse-scheduler-staff')
    if (!saved) return defaultStaff
    return (JSON.parse(saved) as Staff[])
      .filter((person) => !legacySampleIds.has(person.id))
      .map((person, index) => ({
        ...person,
        role: person.role || (index < 3 ? 'senior' : 'junior'),
      }))
  })
  const [holidayPreset, setHolidayPreset] = useState<HolidayPreset>({})
  const [holidayYear, setHolidayYear] = useState<number | null>(null)
  const [holidayError, setHolidayError] = useState('')
  const specialNeeds = useMemo(
    () => makeAutomaticSpecialNeeds(year, month, holidayYear === year ? holidayPreset : {}),
    [holidayPreset, holidayYear, month, year],
  )
  const [schedule, setSchedule] = useState<Schedule>({})
  const [scheduleCreated, setScheduleCreated] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [estimatedSeconds, setEstimatedSeconds] = useState<number | null>(() => {
    const saved = Number(localStorage.getItem('nurse-scheduler-estimated-seconds'))
    return Number.isFinite(saved) && saved > 0 ? saved : null
  })
  const [rules, setRules] = useState<SchedulingRules>(() => {
    const saved = localStorage.getItem('nurse-scheduler-rules')
    if (!saved) return DEFAULT_SCHEDULING_RULES
    try {
      return normalizeSchedulingRules(JSON.parse(saved))
    } catch {
      return DEFAULT_SCHEDULING_RULES
    }
  })
  const [fixedAssignmentsByMonth, setFixedAssignmentsByMonth] = useState<FixedAssignmentsByMonth>(loadFixedAssignments)
  const schedulerWorkerRef = useRef<Worker | null>(null)
  const generationStartedAtRef = useRef(0)
  const [newName, setNewName] = useState('')
  const [newRole, setNewRole] = useState<Role>('junior')
  const [selectedStaff, setSelectedStaff] = useState(staff[0]?.id || '')
  const [vacationDay, setVacationDay] = useState('')
  const [scheduleFilter, setScheduleFilter] = useState('all')
  const [editMode, setEditMode] = useState(false)
  const [draggedAssignment, setDraggedAssignment] = useState<{ personId: string; day: number } | null>(null)
  const [generationFailure, setGenerationFailure] = useState<SchedulingFailure | null>(null)
  const [toast, setToast] = useState('')
  const totalDays = daysInMonth(year, month)
  const firstWeekday = new Date(year, month, 1).getDay()
  const fixedMonthKey = `${year}-${String(month + 1).padStart(2, '0')}`
  const fixedAssignments = useMemo(() => {
    const source = fixedAssignmentsByMonth[fixedMonthKey] || {}
    const normalized: FixedAssignments = {}
    for (let day = 1; day <= totalDays; day += 1) {
      const assignedToday = new Set<string>()
      const dayAssignments: Partial<Record<WorkShift, Array<string | null>>> = {}
      for (const shift of ['D', 'E', 'N', 'S'] as WorkShift[]) {
        const slotCount = shift === 'S' ? specialNeeds[day] || 0 : 2
        if (slotCount === 0) continue
        dayAssignments[shift] = Array.from({ length: slotCount }, (_, slotIndex) => {
          const personId = source[day]?.[shift]?.[slotIndex]
          const person = personId ? staff.find((candidate) => candidate.id === personId) : undefined
          if (!person || person.vacations.includes(day) || assignedToday.has(person.id)) return null
          assignedToday.add(person.id)
          return person.id
        })
      }
      if (Object.values(dayAssignments).some((slots) => slots?.some(Boolean))) normalized[day] = dayAssignments
    }
    return normalized
  }, [fixedAssignmentsByMonth, fixedMonthKey, specialNeeds, staff, totalDays])
  const fixedAssignmentCount = useMemo(() => Object.values(fixedAssignments)
    .flatMap((dayAssignments) => Object.values(dayAssignments))
    .flatMap((slots) => slots || [])
    .filter(Boolean).length, [fixedAssignments])

  useEffect(() => localStorage.setItem('nurse-scheduler-staff', JSON.stringify(staff)), [staff])
  useEffect(() => localStorage.setItem('nurse-scheduler-rules', JSON.stringify(rules)), [rules])
  useEffect(() => localStorage.setItem(
    'nurse-scheduler-fixed-assignments',
    JSON.stringify(fixedAssignmentsByMonth),
  ), [fixedAssignmentsByMonth])
  useEffect(() => {
    const current = fixedAssignmentsByMonth[fixedMonthKey] || {}
    if (JSON.stringify(current) === JSON.stringify(fixedAssignments)) return
    setFixedAssignmentsByMonth((stored) => ({ ...stored, [fixedMonthKey]: fixedAssignments }))
  }, [fixedAssignments, fixedAssignmentsByMonth, fixedMonthKey])
  useEffect(() => {
    let active = true
    setHolidayError('')
    getHolidayPreset(String(year))
      .then((preset) => {
        if (!active) return
        setHolidayPreset(preset)
        setHolidayYear(year)
      })
      .catch(() => {
        if (!active) return
        setHolidayPreset({})
        setHolidayYear(year)
        setHolidayError(`${year}년 공휴일 자료가 없어 주말 규칙만 적용했어요.`)
      })
    return () => {
      active = false
    }
  }, [year])
  useEffect(() => {
    schedulerWorkerRef.current?.terminate()
    schedulerWorkerRef.current = null
    setIsGenerating(false)
    setElapsedSeconds(0)
    setSchedule({})
    setScheduleCreated(false)
    setGenerationFailure(null)
    setEditMode(false)
    setDraggedAssignment(null)
  }, [fixedAssignments, month, specialNeeds, staff, year])
  useEffect(() => {
    if (!isGenerating) return
    const updateElapsed = () => setElapsedSeconds(Math.max(0,
      Math.floor((performance.now() - generationStartedAtRef.current) / 1000)))
    updateElapsed()
    const timer = window.setInterval(updateElapsed, 250)
    return () => window.clearInterval(timer)
  }, [isGenerating])
  useEffect(() => () => schedulerWorkerRef.current?.terminate(), [])
  useEffect(() => {
    if (scheduleFilter !== 'all' && !staff.some((person) => person.id === scheduleFilter)) {
      setScheduleFilter('all')
    }
  }, [scheduleFilter, staff])

  const monthTitle = `${year}년 ${month + 1}월`
  const estimateText = estimatedSeconds
    ? `최근 계산 기준 약 ${formatDuration(estimatedSeconds)}`
    : '보통 20초~2분 · 복잡한 조건은 최대 5분'
  const holidayNamesByDay = useMemo(() => Object.fromEntries(
    Array.from({ length: totalDays }, (_, index) => {
      const day = index + 1
      return [day, holidayYear === year ? holidayPreset[dateKey(year, month, day)] : undefined]
    }).filter(([, names]) => names),
  ) as Record<number, readonly string[]>, [holidayPreset, holidayYear, month, totalDays, year])
  const monthHolidays = useMemo(() => Object.entries(holidayNamesByDay)
    .map(([day, names]) => ({ day: Number(day), names })), [holidayNamesByDay])
  const stats = useMemo(() => staff.map((person) => {
    const values = Object.values(schedule[person.id] || {})
    return {
      id: person.id,
      work: values.filter(isWork).length,
      day: values.filter((shift) => shift === 'D').length,
      evening: values.filter((shift) => shift === 'E').length,
      night: values.filter((shift) => shift === 'N').length,
      special: values.filter((shift) => shift === 'S').length,
      off: values.filter((shift) => shift === 'O').length,
      vacation: values.filter((shift) => shift === 'V').length,
    }
  }), [staff, schedule])
  const focusedPerson = staff.find((person) => person.id === scheduleFilter)
  const visibleStats = focusedPerson
    ? stats.filter((stat) => stat.id === focusedPerson.id)
    : stats
  const uncoveredDays = useMemo(() => scheduleCreated
    ? Array.from({ length: totalDays }, (_, index) => index + 1)
    .filter((day) => (['D', 'E', 'N'] as const).some((shift) =>
      staff.filter((person) => schedule[person.id]?.[day] === shift).length !== 2,
    ) || staff.filter((person) => schedule[person.id]?.[day] === 'S').length !== (specialNeeds[day] || 0))
    : [],
  [schedule, scheduleCreated, specialNeeds, staff, totalDays])
  const algorithmIssues = useMemo(
    () => scheduleCreated
      ? validateSchedule(schedule, staff, totalDays, specialNeeds, rules)
      : [],
    [rules, schedule, scheduleCreated, specialNeeds, staff, totalDays],
  )
  const changeMonth = (offset: number) => {
    const next = new Date(year, month + offset, 1)
    setYear(next.getFullYear())
    setMonth(next.getMonth())
  }

  const toggleRule = (rule: keyof SchedulingRules) => {
    schedulerWorkerRef.current?.terminate()
    schedulerWorkerRef.current = null
    setRules((current) => ({ ...current, [rule]: !current[rule] }))
    setGenerationFailure(null)
    setIsGenerating(false)
    setSchedule({})
    setScheduleCreated(false)
    setElapsedSeconds(0)
  }

  const generate = (activeRules: SchedulingRules = rules) => {
    if (staff.length === 0) {
      setToast('직원을 먼저 등록해 주세요.')
      window.setTimeout(() => setToast(''), 2600)
      return
    }
    schedulerWorkerRef.current?.terminate()
    const worker = new Worker(new URL('./scheduler.worker.ts', import.meta.url), { type: 'module' })
    schedulerWorkerRef.current = worker
    generationStartedAtRef.current = performance.now()
    setGenerationFailure(null)
    setElapsedSeconds(0)
    setIsGenerating(true)
    worker.onmessage = (event: MessageEvent<{
      schedule: Schedule | null
      issues: string[]
      message: string
      relaxation: SchedulingFailure['relaxation']
      suspectedRules: SchedulingFailure['suspectedRules']
      failureKind?: SchedulingFailure['failureKind']
    }>) => {
      if (schedulerWorkerRef.current !== worker) return
      worker.terminate()
      schedulerWorkerRef.current = null
      const duration = Math.max(1, Math.round((performance.now() - generationStartedAtRef.current) / 1000))
      if (!event.data.schedule || event.data.issues.length > 0) {
        setIsGenerating(false)
        setSchedule({})
        setScheduleCreated(false)
        setGenerationFailure({
          message: event.data.message || '현재 설정으로 시간표를 완성할 수 없습니다.',
          issues: event.data.issues,
          relaxation: event.data.relaxation,
          suspectedRules: event.data.suspectedRules || [],
          failureKind: event.data.failureKind || 'error',
        })
        return
      }
      const nextEstimate = estimatedSeconds
        ? Math.max(1, Math.round(estimatedSeconds * 0.65 + duration * 0.35))
        : duration
      localStorage.setItem('nurse-scheduler-estimated-seconds', String(nextEstimate))
      setEstimatedSeconds(nextEstimate)
      setSchedule(event.data.schedule)
      setScheduleCreated(true)
      setGenerationFailure(null)
      setIsGenerating(false)
      setElapsedSeconds(duration)
      setToast(`${duration}초 만에 선택한 규칙을 통과한 시간표를 만들었어요.`)
      window.setTimeout(() => setToast(''), 2600)
    }
    worker.onerror = () => {
      if (schedulerWorkerRef.current !== worker) return
      worker.terminate()
      schedulerWorkerRef.current = null
      setIsGenerating(false)
      setSchedule({})
      setScheduleCreated(false)
      setGenerationFailure({
        message: '계산 작업을 시작하지 못했습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.',
        issues: [],
        relaxation: null,
        suspectedRules: [],
        failureKind: 'error',
      })
      setToast('시간표 계산 중 오류가 발생했어요. 다시 시도해 주세요.')
      window.setTimeout(() => setToast(''), 3600)
    }
    worker.postMessage({ staff, year, month, specialNeeds, rules: activeRules, fixedAssignments })
  }

  const relaxRulesAndGenerate = (ruleKeys: Array<keyof SchedulingRules>) => {
    const relaxedRules = { ...rules }
    ruleKeys.forEach((rule) => {
      relaxedRules[rule] = false
    })
    setRules(relaxedRules)
    generate(relaxedRules)
  }

  const relaxSuggestedRuleAndGenerate = () => {
    if (!generationFailure?.relaxation) return
    relaxRulesAndGenerate(generationFailure.relaxation.rules)
  }

  const cancelGeneration = () => {
    schedulerWorkerRef.current?.terminate()
    schedulerWorkerRef.current = null
    setIsGenerating(false)
    setElapsedSeconds(0)
    setToast('시간표 계산을 취소했어요.')
    window.setTimeout(() => setToast(''), 2600)
  }

  const startAssignmentDrag = (event: DragEvent<HTMLElement>, personId: string, day: number) => {
    if (!editMode) return
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', `${personId}:${day}`)
    setDraggedAssignment({ personId, day })
  }

  const swapAssignment = (event: DragEvent<HTMLElement>, targetPersonId: string, targetDay: number) => {
    event.preventDefault()
    if (!draggedAssignment) return
    if (draggedAssignment.day !== targetDay) {
      setToast('같은 날짜 안에서만 두 직원의 근무를 교환할 수 있어요.')
      window.setTimeout(() => setToast(''), 2600)
      setDraggedAssignment(null)
      return
    }
    if (draggedAssignment.personId === targetPersonId) {
      setDraggedAssignment(null)
      return
    }
    const sourceShift = schedule[draggedAssignment.personId]?.[targetDay]
    const targetShift = schedule[targetPersonId]?.[targetDay]
    if (!sourceShift || !targetShift || sourceShift === 'V' || targetShift === 'V') {
      setToast('휴가는 드래그로 변경할 수 없어요.')
      window.setTimeout(() => setToast(''), 2600)
      setDraggedAssignment(null)
      return
    }
    const next = Object.fromEntries(staff.map((person) => [
      person.id,
      { ...schedule[person.id] },
    ])) as Schedule
    next[draggedAssignment.personId][targetDay] = targetShift
    next[targetPersonId][targetDay] = sourceShift
    const issues = validateSchedule(next, staff, totalDays, specialNeeds, rules)
    setSchedule(next)
    setDraggedAssignment(null)
    setToast(issues.length
      ? `근무를 교환했어요. 현재 규칙 확인이 ${issues.length}개 필요합니다.`
      : '두 직원의 근무를 교환했어요.')
    window.setTimeout(() => setToast(''), 2600)
  }

  const workerDragProps = (personId: string, day: number) => ({
    draggable: editMode,
    onDragStart: (event: DragEvent<HTMLElement>) => startAssignmentDrag(event, personId, day),
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (draggedAssignment?.day === day && draggedAssignment.personId !== personId) event.preventDefault()
    },
    onDrop: (event: DragEvent<HTMLElement>) => swapAssignment(event, personId, day),
    onDragEnd: () => setDraggedAssignment(null),
  })

  const setFixedAssignment = (day: number, shift: WorkShift, slotIndex: number, personId: string) => {
    setFixedAssignmentsByMonth((stored) => {
      const monthAssignments = structuredClone(stored[fixedMonthKey] || {}) as FixedAssignments
      const dayAssignments = monthAssignments[day] || {}
      for (const candidateShift of ['D', 'E', 'N', 'S'] as WorkShift[]) {
        dayAssignments[candidateShift] = (dayAssignments[candidateShift] || []).map((assignedId) =>
          personId && assignedId === personId ? null : assignedId)
      }
      const slotCount = shift === 'S' ? specialNeeds[day] || 0 : 2
      const slots = Array.from({ length: slotCount }, (_, index) => dayAssignments[shift]?.[index] || null)
      slots[slotIndex] = personId || null
      dayAssignments[shift] = slots
      monthAssignments[day] = dayAssignments
      return { ...stored, [fixedMonthKey]: monthAssignments }
    })
    setGenerationFailure(null)
  }

  const clearFixedAssignments = () => {
    setFixedAssignmentsByMonth((stored) => ({ ...stored, [fixedMonthKey]: {} }))
    setToast(`${monthTitle} 고정 근무를 모두 해제했어요.`)
    window.setTimeout(() => setToast(''), 2600)
  }

  const fixedSlotOptions = (day: number, shift: WorkShift, slotIndex: number) => {
    const currentPersonId = fixedAssignments[day]?.[shift]?.[slotIndex] || ''
    const assignedToday = new Set(Object.values(fixedAssignments[day] || {})
      .flatMap((slots) => slots || [])
      .filter((personId): personId is string => Boolean(personId)))
    const capacity = shift === 'S' ? specialNeeds[day] || 0 : 2
    const otherPeopleInShift = (fixedAssignments[day]?.[shift] || [])
      .filter((personId, index): personId is string => index !== slotIndex && Boolean(personId))
    const seniorAlreadyFixed = otherPeopleInShift.some((personId) =>
      staff.find((person) => person.id === personId)?.role === 'senior')
    const thisSelectionMustBeSenior = otherPeopleInShift.length === capacity - 1 && !seniorAlreadyFixed
    return staff.filter((person) => !person.vacations.includes(day) &&
      (!assignedToday.has(person.id) || person.id === currentPersonId) &&
      (!thisSelectionMustBeSenior || person.role === 'senior' || person.id === currentPersonId))
  }

  const toggleEditMode = () => {
    setEditMode((current) => !current)
    setScheduleFilter('all')
    setDraggedAssignment(null)
  }

  const addStaff = () => {
    const name = newName.trim()
    if (!name) return
    const person: Staff = { id: crypto.randomUUID(), name, role: newRole, vacations: [] }
    const next = [...staff, person]
    setStaff(next)
    setSelectedStaff(person.id)
    setNewName('')
  }

  const removeStaff = (id: string) => {
    const next = staff.filter((person) => person.id !== id)
    setStaff(next)
    setSelectedStaff(next[0]?.id || '')
  }

  const addVacation = () => {
    const day = Number(vacationDay)
    if (!selectedStaff || !day || day < 1 || day > totalDays) {
      setToast(`1일부터 ${totalDays}일 사이의 날짜를 입력해 주세요.`)
      window.setTimeout(() => setToast(''), 2600)
      return
    }
    const next = staff.map((person) => person.id === selectedStaff
      ? { ...person, vacations: [...new Set([...person.vacations, day])].sort((a, b) => a - b) }
      : person)
    setStaff(next)
    setVacationDay('')
  }

  const removeVacation = (personId: string, day: number) => {
    const next = staff.map((person) => person.id === personId
      ? { ...person, vacations: person.vacations.filter((vacation) => vacation !== day) }
      : person)
    setStaff(next)
  }

  const changeRole = (id: string, role: Role) => {
    const next = staff.map((person) => person.id === id ? { ...person, role } : person)
    setStaff(next)
  }

  const downloadScheduleImage = async () => {
    const weeks = Math.ceil((firstWeekday + totalDays) / 7)
    const width = 1800
    const margin = 60
    const cellWidth = (width - margin * 2) / 7
    const cellHeight = 215
    const calendarTop = 190
    const summaryTop = calendarTop + 48 + weeks * cellHeight + 45
    const summaryRows = Math.ceil(staff.length / 2)
    const height = summaryTop + 95 + summaryRows * 78 + 70
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) return

    context.fillStyle = '#f7f9f7'
    context.fillRect(0, 0, width, height)
    context.fillStyle = '#00664f'
    context.fillRect(0, 0, width, 12)
    context.fillStyle = '#173c32'
    context.font = '700 40px "Noto Sans KR", sans-serif'
    context.fillText('이대목동병원 사무부 원무팀 근무표', margin, 78)
    context.font = '700 25px "Noto Sans KR", sans-serif'
    context.fillStyle = '#00664f'
    context.fillText(monthTitle, margin, 126)
    context.font = '18px "Noto Sans KR", sans-serif'
    context.fillStyle = '#71817b'
    context.fillText(`D·E·N 각 2명 · S/P 토 1명·일/공휴일 2명 · 생성일 ${new Date().toLocaleDateString('ko-KR')}`, margin, 158)

    const weekdays = ['일', '월', '화', '수', '목', '금', '토']
    weekdays.forEach((weekday, index) => {
      const x = margin + index * cellWidth
      context.fillStyle = '#edf3f0'
      context.fillRect(x, calendarTop, cellWidth, 48)
      context.strokeStyle = '#d8e4df'
      context.strokeRect(x, calendarTop, cellWidth, 48)
      context.fillStyle = index === 0 ? '#c25e4b' : index === 6 ? '#39749b' : '#53655e'
      context.font = '700 18px "Noto Sans KR", sans-serif'
      context.textAlign = 'center'
      context.fillText(weekday, x + cellWidth / 2, calendarTop + 31)
    })

    for (let day = 1; day <= totalDays; day += 1) {
      const position = firstWeekday + day - 1
      const column = position % 7
      const row = Math.floor(position / 7)
      const x = margin + column * cellWidth
      const y = calendarTop + 48 + row * cellHeight
      context.fillStyle = '#ffffff'
      context.fillRect(x, y, cellWidth, cellHeight)
      context.strokeStyle = '#d8e4df'
      context.strokeRect(x, y, cellWidth, cellHeight)
      context.textAlign = 'left'
      context.font = '700 19px "Noto Sans KR", sans-serif'
      context.fillStyle = column === 0 ? '#c25e4b' : column === 6 ? '#39749b' : '#263a33'
      context.fillText(String(day), x + 13, y + 28)
      if (holidayNamesByDay[day]) {
        context.fillStyle = '#b85d48'
        context.font = '700 10px "Noto Sans KR", sans-serif'
        context.fillText(holidayNamesByDay[day].join(' · '), x + 40, y + 27, cellWidth - 50)
      }

      const rows: Array<{ shift: WorkShift; label: string }> = [
        { shift: 'D', label: 'D' }, { shift: 'E', label: 'E' }, { shift: 'N', label: 'N' },
        ...(specialNeeds[day] ? [{ shift: 'S' as WorkShift, label: 'S/P' }] : []),
      ]
      rows.forEach(({ shift, label }, index) => {
        const workers = staff.filter((person) => schedule[person.id]?.[day] === shift)
        const rowY = y + 58 + index * 31
        const colors: Record<WorkShift, string> = { D: '#dceebd', E: '#cde8df', N: '#395d56', S: '#f5e3a9' }
        context.fillStyle = colors[shift]
        context.fillRect(x + 12, rowY - 17, 38, 24)
        context.fillStyle = shift === 'N' ? '#ffffff' : '#35534a'
        context.font = '700 13px sans-serif'
        context.fillText(label, x + 18, rowY)
        context.fillStyle = '#263a33'
        context.font = '700 15px "Noto Sans KR", sans-serif'
        context.fillText(workers.map((person) => person.name).join(' · ') || '—', x + 60, rowY)
      })
      const vacationers = staff.filter((person) => schedule[person.id]?.[day] === 'V')
      if (vacationers.length) {
        context.fillStyle = '#a9654e'
        context.font = '13px "Noto Sans KR", sans-serif'
        context.fillText(`휴가 ${vacationers.map((person) => person.name).join(' · ')}`, x + 12, y + cellHeight - 14)
      }
    }

    context.textAlign = 'left'
    context.fillStyle = '#173c32'
    context.font = '700 25px "Noto Sans KR", sans-serif'
    context.fillText('직원별 월간 근무 집계', margin, summaryTop)
    stats.forEach((stat, index) => {
      const person = staff.find((candidate) => candidate.id === stat.id)
      const column = index % 2
      const row = Math.floor(index / 2)
      const x = margin + column * ((width - margin * 2) / 2 + 8)
      const y = summaryTop + 30 + row * 78
      const cardWidth = (width - margin * 2) / 2 - 8
      context.fillStyle = '#ffffff'
      context.fillRect(x, y, cardWidth, 62)
      context.strokeStyle = '#d8e4df'
      context.strokeRect(x, y, cardWidth, 62)
      context.fillStyle = '#263a33'
      context.font = '700 17px "Noto Sans KR", sans-serif'
      context.fillText(`${person?.name} · ${person?.role === 'senior' ? '사수' : '부사수'}`, x + 15, y + 25)
      context.fillStyle = '#62736c'
      context.font = '14px "Noto Sans KR", sans-serif'
      context.fillText(`D ${stat.day}일   E ${stat.evening}일   N ${stat.night}일   S/P ${stat.special}일   O ${stat.off}일   휴가 ${stat.vacation}일`, x + 15, y + 49)
    })

    const link = document.createElement('a')
    link.download = `이대목동병원_원무팀_${year}-${String(month + 1).padStart(2, '0')}_근무표.png`
    link.href = canvas.toDataURL('image/png')
    link.click()
    setToast('근무표 이미지를 저장했어요.')
    window.setTimeout(() => setToast(''), 2600)
  }

  return (
    <main>
      <header className="topbar">
        <div className="brand">
          <img className="brand-logo" src="/logo.png" alt="이대목동병원" />
          <div className="brand-copy"><strong>사무부 원무팀</strong><span>근무표 관리</span></div>
        </div>
        <div className="top-actions">
          <button className="download" onClick={downloadScheduleImage} disabled={!scheduleCreated}>↓ 이미지 저장</button>
          <button className={`generate ${isGenerating ? 'is-loading' : ''}`} onClick={isGenerating ? cancelGeneration : () => generate()} aria-busy={isGenerating}>
            {isGenerating ? <><span className="loading-spinner" aria-hidden="true" />계산 중 · 취소</> : <><span>✦</span>시간표 만들기</>}
          </button>
        </div>
      </header>

      <section className="intro">
        <div>
          <p className="eyebrow">MONTHLY SCHEDULE</p>
          <h1>사무부 원무팀<br /><em>근무표 만들기</em></h1>
          <p className="intro-copy">직원과 휴가를 등록한 뒤 시간표 만들기를 누르면<br />원무팀 근무 규칙에 맞춰 한 달 스케줄을 완성해 드려요.</p>
        </div>
        <div className="rules">
          <p>잠금 규칙은 항상 적용 · 나머지는 눌러서 선택</p>
          <div className="rule-tags">
            {requiredRuleLabels.map((label) => <span className="required-rule" key={label}><b aria-hidden="true">🔒</b>{label}</span>)}
            {optionalRuleKeys.map((rule) => <button
              type="button"
              className={`optional-rule ${rules[rule] ? 'active' : 'inactive'}`}
              aria-pressed={rules[rule]}
              onClick={() => toggleRule(rule)}
              key={rule}
            >{RULE_LABELS[rule]} · {rules[rule] ? '적용' : '제외'}</button>)}
          </div>
        </div>
      </section>

      <section className="workspace">
        <aside>
          <div className="panel">
            <div className="panel-title"><div><span className="step">01</span><h2>직원 관리</h2></div><b>{staff.length}명</b></div>
            <div className="add-row">
              <input value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addStaff()} placeholder="직원 이름" aria-label="직원 이름" />
              <select value={newRole} onChange={(e) => setNewRole(e.target.value as Role)} aria-label="새 직원 역할"><option value="senior">사수</option><option value="junior">부사수</option></select>
              <button onClick={addStaff} aria-label="직원 추가">＋</button>
            </div>
            <div className="staff-list">
              {staff.map((person, index) => <div className="staff-item" key={person.id}>
                <span className={`avatar avatar-${index % 5}`}>{person.name.slice(-2)}</span>
                <div><strong>{person.name}</strong><small>근무 {stats.find((s) => s.id === person.id)?.work || 0}일 · N {stats.find((s) => s.id === person.id)?.night || 0}회</small></div>
                <select className={`role-select ${person.role}`} value={person.role} onChange={(e) => changeRole(person.id, e.target.value as Role)} aria-label={`${person.name} 역할`}><option value="senior">사수</option><option value="junior">부사수</option></select>
                <button onClick={() => removeStaff(person.id)} aria-label={`${person.name} 삭제`}>×</button>
              </div>)}
            </div>
          </div>

          <div className="panel">
            <div className="panel-title"><div><span className="step">02</span><h2>휴가 등록</h2></div></div>
            <label>직원<select value={selectedStaff} onChange={(e) => setSelectedStaff(e.target.value)}>{staff.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label>
            <label>휴가 날짜<div className="vacation-input"><input type="number" min="1" max={totalDays} value={vacationDay} onChange={(e) => setVacationDay(e.target.value)} placeholder="날짜 입력" /><span>일</span></div></label>
            <button className="secondary" onClick={addVacation}>휴가 추가</button>
            <div className="vacation-list">{staff.filter((person) => person.vacations.length > 0).map((person) => <div key={person.id}><strong>{person.name}</strong><span className="vacation-chips">{person.vacations.map((day) => <button key={day} onClick={() => removeVacation(person.id, day)} aria-label={`${person.name} ${day}일 휴가 삭제`}>{day}일 <b>×</b></button>)}</span></div>)}</div>
          </div>

          <div className="panel staffing">
            <div className="panel-title"><div><span className="step">03</span><h2>하루 필요 인원</h2></div></div>
            {(['D', 'E', 'N'] as const).map((shift) => <div className="fixed-staff" key={shift}><span className={`shift-dot ${shift}`}>{shift}</span><strong>{shiftInfo[shift].label}</strong><span>사수 최소 1명 필수</span><b>2명</b></div>)}
            <p className="role-count">현재 사수 {staff.filter((person) => person.role === 'senior').length}명 · 부사수 {staff.filter((person) => person.role === 'junior').length}명</p>
          </div>

          <div className="panel automatic-special">
            <div className="panel-title"><div><span className="step">04</span><h2>S/P 자동 배치</h2></div><b>09–17시</b></div>
            <div className="fixed-staff"><span className="shift-dot S">S</span><strong>토요일</strong><span>사수급 필수</span><b>1명</b></div>
            <div className="fixed-staff"><span className="shift-dot S">S</span><strong>일요일</strong><span>사수+부사수/사수</span><b>2명</b></div>
            <div className="fixed-staff"><span className="shift-dot S">S</span><strong>공휴일</strong><span>사수+부사수/사수</span><b>2명</b></div>
            {holidayError && <p className="holiday-error">{holidayError}</p>}
            {!holidayError && <div className="special-list">
              {monthHolidays.length > 0
                ? monthHolidays.map(({ day, names }) => <span key={day}>{day}일 · {names.join(' · ')}</span>)
                : <small>이달에는 공휴일이 없습니다.</small>}
            </div>}
          </div>
        </aside>

        <div className="calendar-card">
          {algorithmIssues.length > 0 && <div className="schedule-warning"><strong>규칙 검증 문제 {algorithmIssues.length}개</strong><span>{uncoveredDays.length > 0 ? ` · 편성 불가: ${uncoveredDays.slice(0, 8).map((day) => `${day}일`).join(', ')}` : ''}</span><p>{algorithmIssues.slice(0, 4).join(' · ')}{algorithmIssues.length > 4 ? ` 외 ${algorithmIssues.length - 4}개` : ''}</p></div>}
          <div className="calendar-head">
            <button onClick={() => changeMonth(-1)} aria-label="이전 달">‹</button>
            <div><h2>{monthTitle}</h2><p>날짜별 근무자를 한눈에 확인하세요</p></div>
            <button onClick={() => changeMonth(1)} aria-label="다음 달">›</button>
          </div>
          {!scheduleCreated ? <div className={`schedule-empty ${!isGenerating && !generationFailure ? 'idle' : ''}`} aria-live="polite">
            <div className="blank-calendar-preview" aria-hidden={isGenerating || Boolean(generationFailure)}>
              <div className="weekdays">{['일', '월', '화', '수', '목', '금', '토'].map((weekday, index) => <div key={weekday} className={index === 0 ? 'sun' : index === 6 ? 'sat' : ''}>{weekday}</div>)}</div>
              <div className="calendar-grid">
                {Array.from({ length: firstWeekday }, (_, index) => <div className="day-cell empty" key={`preview-empty-${index}`} />)}
                {Array.from({ length: totalDays }, (_, index) => {
                  const day = index + 1
                  const weekday = new Date(year, month, day).getDay()
                  const holidayNames = holidayNamesByDay[day]
                  const vacationNames = staff
                    .filter((person) => person.vacations.includes(day))
                    .map((person) => person.name.length === 3 ? person.name.slice(1) : person.name)
                  return <article className={`day-cell ${holidayNames ? 'holiday' : ''}`} key={`preview-${day}`}>
                    <div className={`day-number ${holidayNames || weekday === 0 ? 'sun' : weekday === 6 ? 'sat' : ''}`}>
                      <span>{day}</span>
                      {holidayNames && <small>{holidayNames.join(' · ')}</small>}
                    </div>
                    <div className="day-shifts blank-day-shifts">
                      {(['D', 'E', 'N'] as const).map((shift) => <div className={`day-shift shift-${shift}`} key={shift}>
                        <span>{shift}</span>
                        <div>{Array.from({ length: 2 }, (_, slotIndex) => {
                          const personId = fixedAssignments[day]?.[shift]?.[slotIndex] || ''
                          return <select
                            className={`fixed-slot ${personId ? 'selected' : ''}`}
                            aria-label={`${day}일 ${shift} ${slotIndex + 1}번째 고정 직원`}
                            title={personId ? '고정된 직원 변경 또는 해제' : '클릭해서 직원을 고정 배정'}
                            key={slotIndex}
                            value={personId}
                            disabled={isGenerating || Boolean(generationFailure)}
                            onChange={(event) => setFixedAssignment(day, shift, slotIndex, event.target.value)}
                          >
                            <option value="">＋</option>
                            {fixedSlotOptions(day, shift, slotIndex).map((person) => <option key={person.id} value={person.id}>
                              {person.name}
                            </option>)}
                          </select>
                        })}</div>
                      </div>)}
                      {(specialNeeds[day] || 0) > 0 && <div className="day-shift shift-S">
                        <span>S</span>
                        <div>{Array.from({ length: specialNeeds[day] || 0 }, (_, slotIndex) => {
                          const personId = fixedAssignments[day]?.S?.[slotIndex] || ''
                          return <select
                            className={`fixed-slot ${personId ? 'selected' : ''}`}
                            aria-label={`${day}일 S/P ${slotIndex + 1}번째 고정 직원`}
                            title={personId ? '고정된 직원 변경 또는 해제' : '클릭해서 직원을 고정 배정'}
                            key={slotIndex}
                            value={personId}
                            disabled={isGenerating || Boolean(generationFailure)}
                            onChange={(event) => setFixedAssignment(day, 'S', slotIndex, event.target.value)}
                          >
                            <option value="">＋</option>
                            {fixedSlotOptions(day, 'S', slotIndex).map((person) => <option key={person.id} value={person.id}>
                              {person.name}
                            </option>)}
                          </select>
                        })}</div>
                      </div>}
                    </div>
                    {vacationNames.length > 0 && <div className="day-vacation">휴가 {vacationNames.join(' · ')}</div>}
                  </article>
                })}
              </div>
            </div>
            <div className="schedule-empty-content">
            {isGenerating ? <>
              <div className="large-spinner"><span className="loading-spinner" aria-hidden="true" /></div>
              <strong>{monthTitle} 시간표를 계산하고 있어요</strong>
              <p className="generation-time">{estimateText}<br />현재 경과 {formatDuration(elapsedSeconds)}</p>
              <small>{elapsedSeconds >= 120
                ? '복잡한 휴가·연속 근무 조합을 계속 확인하고 있습니다. 5분까지 완성표를 찾고, 그 뒤에도 못 찾으면 판정 불가로 안내합니다.'
                : '월 전체의 근무·휴가·사수·연속 근무·균형 조건을 동시에 계산합니다. 완성된 시간표만 표시됩니다.'}</small>
              <button className="cancel-generation" onClick={cancelGeneration}>계산 취소</button>
            </> : generationFailure ? <>
              <span className="failure-icon">!</span>
              <strong>{generationFailure.failureKind === 'unknown'
                ? '아직 가능 여부를 확정하지 못했어요'
                : generationFailure.failureKind === 'error'
                  ? '시간표 계산 중 문제가 발생했어요'
                  : '현재 조건으로 가능한 시간표가 없어요'}</strong>
              <p className="failure-message">{generationFailure.message}</p>
              {generationFailure.issues.length > 0 && <div className="diagnostic-details">
                <strong>계산기가 확인한 원인</strong>
                <ul>{generationFailure.issues.slice(0, 6).map((issue) => <li key={issue}>{issue}</li>)}</ul>
                {generationFailure.issues.length > 6 && <small>이외 {generationFailure.issues.length - 6}개 문제가 더 있습니다.</small>}
                {generationFailure.suspectedRules.length > 0 && <div className="suspected-rules">
                  <b>관련 선택 규칙</b>
                  {generationFailure.suspectedRules.map(({ rule, title }) => <button
                    type="button"
                    onClick={() => relaxRulesAndGenerate([rule])}
                    key={rule}
                  >{title} 제외 후 재진단</button>)}
                </div>}
              </div>}
              {generationFailure.relaxation ? <div className="constraint-suggestion">
                <small><b>{generationFailure.relaxation.title}</b>{generationFailure.relaxation.rules.length > 1 ? ' 규칙들이 함께 충돌했습니다.' : ' 규칙 때문에 완성 검증을 통과하지 못했습니다.'}</small>
                <p>{generationFailure.relaxation.reason}</p>
                <button className="generate" onClick={relaxSuggestedRuleAndGenerate}>{generationFailure.relaxation.rules.length > 1 ? '이 규칙들을 제외하고 다시 만들기' : '이 규칙을 제외하고 다시 만들기'}</button>
                <button className="keep-constraint" onClick={() => setGenerationFailure(null)}>규칙 유지하기</button>
              </div> : <div className="constraint-suggestion no-relaxation">
                <small>{generationFailure.failureKind === 'infeasible'
                  ? '한 가지 선택 규칙만 제외해서는 해결되지 않았습니다. 위 관련 규칙을 조정하거나 직원·휴가 구성을 확인해 주세요.'
                  : generationFailure.failureKind === 'unknown'
                    ? '불가능 판정이 아닙니다. 계산을 다시 시도하거나 선택 규칙을 줄이면 더 빨리 확인할 수 있습니다.'
                    : '계산기 실행 문제입니다. 페이지를 새로고침한 뒤 같은 조건으로 다시 시도해 주세요.'}</small>
                <button className="generate" onClick={() => generate()}>같은 조건으로 다시 시도</button>
                <button className="keep-constraint" onClick={() => setGenerationFailure(null)}>직원·휴가·선택 규칙 확인</button>
              </div>}
            </> : <>
              <span>✦</span>
              <strong>{monthTitle} 고정 근무를 먼저 지정할 수 있어요</strong>
              <p>달력의 빈 칸을 눌러 직원을 선택하세요. 선택하지 않은 칸은 자동으로 배정됩니다.<br />고정 없이 바로 시간표를 만들어도 됩니다.</p>
              <div className="fixed-assignment-actions">
                {fixedAssignmentCount > 0 && <button className="clear-fixed" onClick={clearFixedAssignments}>
                  {fixedAssignmentCount}명 고정 · 전체 해제
                </button>}
                <button className="generate" onClick={() => generate()}>시간표 만들기</button>
              </div>
            </>}
            </div>
          </div> : <>
          <div className="calendar-filter">
            <label htmlFor="schedule-filter">직원별 보기</label>
            <select id="schedule-filter" value={scheduleFilter} disabled={editMode} onChange={(event) => setScheduleFilter(event.target.value)}>
              <option value="all">전체 직원</option>
              {staff.map((person) => <option key={person.id} value={person.id}>{person.name} · {person.role === 'senior' ? '사수' : '부사수'}</option>)}
            </select>
            <button className={`edit-toggle ${editMode ? 'active' : ''}`} onClick={toggleEditMode}>{editMode ? '수정 완료' : '직접 수정'}</button>
            <span>{editMode ? '같은 날짜의 직원 이름을 서로 드래그하면 근무가 교환됩니다.' : focusedPerson ? `${focusedPerson.name}님의 근무만 표시 중` : '모든 직원의 근무를 표시 중'}</span>
          </div>
          <div className="month-calendar">
            <div className="weekdays">{['일', '월', '화', '수', '목', '금', '토'].map((weekday, index) => <div key={weekday} className={index === 0 ? 'sun' : index === 6 ? 'sat' : ''}>{weekday}</div>)}</div>
            <div className="calendar-grid">
              {Array.from({ length: firstWeekday }, (_, index) => <div className="day-cell empty" key={`empty-${index}`} />)}
              {Array.from({ length: totalDays }, (_, index) => {
                const day = index + 1
                const weekday = new Date(year, month, day).getDay()
                const holidayNames = holidayNamesByDay[day]
                return <article className={`day-cell ${holidayNames ? 'holiday' : ''}`} key={day}>
                  <div className={`day-number ${holidayNames || weekday === 0 ? 'sun' : weekday === 6 ? 'sat' : ''}`}>
                    <span>{day}</span>
                    {holidayNames && <small title={holidayNames.join(' · ')}>{holidayNames.join(' · ')}</small>}
                  </div>
                  <div className="day-shifts">
                    {focusedPerson ? (() => {
                      const shift = schedule[focusedPerson.id]?.[day] || 'O'
                      return <div className={`day-shift personal-shift shift-${shift}`}>
                        <span>{shift === 'S' ? 'S' : shift}</span>
                        <div><b className="personal-label">{shiftInfo[shift].label}</b></div>
                      </div>
                    })() : <>
                      {(['D', 'E', 'N'] as const).map((shift) => {
                        const workers = staff.filter((person) => schedule[person.id]?.[day] === shift)
                        return <div className={`day-shift shift-${shift}`} key={shift}>
                          <span>{shift}</span>
                          <div>{workers.map((person) => <b {...workerDragProps(person.id, day)} className={`${person.role} ${editMode ? 'draggable-worker' : ''} ${draggedAssignment?.personId === person.id && draggedAssignment.day === day ? 'dragging' : ''}`} key={person.id} title={editMode ? '같은 날짜의 다른 직원에게 드래그해 근무 교환' : person.role === 'senior' ? '사수' : '부사수'}>{person.name.length === 3 ? person.name.slice(1) : person.name}</b>)}</div>
                        </div>
                      })}
                      {(specialNeeds[day] || 0) > 0 && <div className="day-shift shift-S">
                        <span>S</span>
                        <div>{staff.filter((person) => schedule[person.id]?.[day] === 'S').map((person) => <b {...workerDragProps(person.id, day)} className={`${person.role} ${editMode ? 'draggable-worker' : ''} ${draggedAssignment?.personId === person.id && draggedAssignment.day === day ? 'dragging' : ''}`} key={person.id} title={editMode ? '같은 날짜의 다른 직원에게 드래그해 근무 교환' : 'S/P 09:00–17:00'}>{person.name.length === 3 ? person.name.slice(1) : person.name}</b>)}</div>
                      </div>}
                    </>}
                  </div>
                  {!focusedPerson && staff.some((person) => schedule[person.id]?.[day] === 'V') && <div className="day-vacation">휴가 {staff.filter((person) => schedule[person.id]?.[day] === 'V').map((person) => person.name.length === 3 ? person.name.slice(1) : person.name).join(' · ')}</div>}
                </article>
              })}
            </div>
          </div>
          <div className="summary">
            <div className="summary-title"><div><strong>{focusedPerson ? `${focusedPerson.name} 월간 근무 집계` : '직원별 월간 근무 집계'}</strong><p>근무 종류별 일수와 전체 근무일을 확인하세요.</p></div><span>{monthTitle}</span></div>
            <div className={`summary-grid ${focusedPerson ? 'single' : ''}`}>
              {visibleStats.map((stat) => {
                const person = staff.find((candidate) => candidate.id === stat.id)
                return <article key={stat.id}>
                  <div className="summary-person"><b>{person?.name}</b><small>{person?.role === 'senior' ? '사수' : '부사수'}</small></div>
                  <div className="summary-counts">
                    <span><i className="D">D</i>데이 <b>{stat.day}일</b></span>
                    <span><i className="E">E</i>이브닝 <b>{stat.evening}일</b></span>
                    <span><i className="N">N</i>나이트 <b>{stat.night}일</b></span>
                    <span><i className="S">S</i>S/P <b>{stat.special}일</b></span>
                    <span><i className="O">O</i>오프 <b>{stat.off}일</b></span>
                    <span><i className="V">V</i>휴가 <b>{stat.vacation}일</b></span>
                  </div>
                  <div className="summary-total">전체 근무 <strong>{stat.work}일</strong></div>
                </article>
              })}
            </div>
          </div>
          </>}
        </div>
      </section>
      <footer className="site-footer">
        <div className="footer-main">
          <div className="footer-inner">
            <div className="footer-brand">
              <strong>이대목동병원 사무부 원무팀 근무표</strong>
              <span>근무표 작성과 검토를 지원하는 내부용 시스템</span>
            </div>
            <div className="footer-notice">
              <strong>안전한 사용을 위해</strong>
              <span>자동 생성된 시간표는 최종 확정 전 담당자가 다시 확인해 주세요.<br />모든 근무 정보는 현재 브라우저에만 저장됩니다.</span>
            </div>
          </div>
        </div>
        <div className="footer-bottom">
          <div>
            <span>© 2026 원무팀 근무표. All rights reserved.</span>
            <span>최종 업데이트 2026.08.01</span>
            <span>Internal Scheduling Support System</span>
          </div>
        </div>
      </footer>
      {toast && <div className="toast">{toast}</div>}
    </main>
  )
}

export default App
