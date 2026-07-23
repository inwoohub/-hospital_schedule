import { useEffect, useMemo, useState } from 'react'
import './App.css'

type Shift = 'D' | 'E' | 'N' | 'S' | 'O' | 'V'
type WorkShift = 'D' | 'E' | 'N' | 'S'
type Role = 'senior' | 'junior'
type Staff = { id: string; name: string; role: Role; vacations: number[] }
type Schedule = Record<string, Record<number, Shift>>

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

const isWork = (shift?: Shift) => shift === 'D' || shift === 'E' || shift === 'N' || shift === 'S'

function validateSchedule(schedule: Schedule, staff: Staff[], totalDays: number, specialNeeds: Record<number, number>) {
  const issues: string[] = []
  for (let day = 1; day <= totalDays; day += 1) {
    ;(['D', 'E', 'N'] as const).forEach((shift) => {
      const workers = staff.filter((person) => schedule[person.id]?.[day] === shift)
      if (workers.length !== 2) issues.push(`${day}일 ${shift} ${workers.length}명`)
    })
    const specialWorkers = staff.filter((person) => schedule[person.id]?.[day] === 'S')
    if (specialWorkers.length !== (specialNeeds[day] || 0)) issues.push(`${day}일 S/P ${specialWorkers.length}명`)
  }
  staff.forEach((person) => {
    let nightRun = 0
    let workRun = 0
    for (let day = 1; day <= totalDays; day += 1) {
      const shift = schedule[person.id]?.[day]
      const prev = schedule[person.id]?.[day - 1]
      const prev2 = schedule[person.id]?.[day - 2]
      if (person.vacations.includes(day) && shift !== 'V') issues.push(`${day}일 ${person.name} 휴가 미반영`)
      if (prev === 'N' && shift !== 'N' && shift !== 'O') issues.push(`${day}일 ${person.name} N 다음 ${shift}`)
      if (shift === 'D' && prev === 'O' && prev2 === 'N') issues.push(`${day}일 ${person.name} N-O-D`)
      if (shift === 'N' && person.vacations.includes(day + 1)) issues.push(`${day}일 ${person.name} 휴가 전날 N`)
      if (shift === 'N') {
        nightRun += 1
      } else {
        if (nightRun === 1 || nightRun > 3) issues.push(`${day - 1}일 ${person.name} N ${nightRun}일 연속`)
        nightRun = 0
      }
      if (isWork(shift)) {
        workRun += 1
        if (workRun >= 4) issues.push(`${day}일 ${person.name} ${workRun}일 연속 근무`)
      } else {
        workRun = 0
      }
    }
    if (nightRun === 1 || nightRun > 3) issues.push(`${totalDays}일 ${person.name} N ${nightRun}일 연속`)
  })
  return [...new Set(issues)]
}

function makeSchedule(staff: Staff[], year: number, month: number, specialNeeds: Record<number, number>) {
  const totalDays = daysInMonth(year, month)
  const result: Schedule = Object.fromEntries(staff.map((person) => [person.id, {}]))
  const workCount = Object.fromEntries(staff.map((person) => [person.id, 0]))
  const nightCount = Object.fromEntries(staff.map((person) => [person.id, 0]))
  const weekendCount = Object.fromEntries(staff.map((person) => [person.id, 0]))
  let deadline = Date.now() + 500
  let bestSchedule: Schedule | null = null
  let bestScore = Number.POSITIVE_INFINITY
  let bestDepth = 0
  let bestPartial: Schedule | null = null
  let solutions = 0

  staff.forEach((person) => {
    person.vacations.forEach((day) => {
      if (day <= totalDays) result[person.id][day] = 'V'
    })
  })

  const canAssign = (person: Staff, day: number, shift: WorkShift) => {
    if (result[person.id][day]) return false
    const prev = result[person.id][day - 1]
    const prev2 = result[person.id][day - 2]
    const prev3 = result[person.id][day - 3]
    if (isWork(prev) && isWork(prev2) && isWork(prev3)) return false
    if (shift === 'N' && person.vacations.includes(day + 1)) return false
    if (shift === 'N' && prev === 'N' && prev2 === 'N' && prev3 === 'N') return false
    if (shift === 'N' && prev !== 'N' && day === totalDays) return false
    if (prev === 'N' && shift !== 'N') return false
    if (shift === 'D' && (prev === 'N' || (prev === 'O' && prev2 === 'N'))) return false
    return true
  }

  const cloneSchedule = () => Object.fromEntries(
    staff.map((person) => [person.id, { ...result[person.id] }]),
  ) as Schedule

  const variance = (values: number[]) => {
    if (!values.length) return 0
    const average = values.reduce((sum, value) => sum + value, 0) / values.length
    return values.reduce((sum, value) => sum + (value - average) ** 2, 0)
  }

  const finalScore = () =>
    variance(staff.map((person) => workCount[person.id])) * 10 +
    variance(staff.map((person) => nightCount[person.id])) * 14 +
    variance(staff.map((person) => weekendCount[person.id])) * 5

  const makeDayPlans = (day: number, allowSubstitution: boolean) => {
    const dayShifts: Array<{ shift: WorkShift; count: number }> = [
      { shift: 'N', count: 2 },
      { shift: 'D', count: 2 },
      { shift: 'E', count: 2 },
      ...(specialNeeds[day] ? [{ shift: 'S' as WorkShift, count: specialNeeds[day] }] : []),
    ]
    const plans: Array<Array<{ person: Staff; shift: WorkShift }>> = []
    const picked = new Set<string>()
    const current: Array<{ person: Staff; shift: WorkShift }> = []

    const buildShift = (shiftIndex: number) => {
      if (plans.length >= 60) return
      if (shiftIndex === dayShifts.length) {
        plans.push([...current])
        return
      }
      const { shift, count } = dayShifts[shiftIndex]
      const eligible = staff.filter((person) => !picked.has(person.id) && canAssign(person, day, shift))
      const groups: Staff[][] = []
      if (count === 1) {
        eligible.forEach((person) => groups.push([person]))
      } else {
        for (let first = 0; first < eligible.length; first += 1) {
          for (let second = first + 1; second < eligible.length; second += 1) {
            groups.push([eligible[first], eligible[second]])
          }
        }
      }
      const mustContinueNight = shift === 'N'
        ? staff.filter((person) =>
          result[person.id][day - 1] === 'N' && result[person.id][day - 2] !== 'N',
        ).map((person) => person.id)
        : []
      const requiredGroups = groups.filter((group) =>
        mustContinueNight.every((id) => group.some((person) => person.id === id)),
      )
      const validGroups = shift === 'N' ? requiredGroups : groups
      const balancedGroups = shift !== 'S' && count === 2
        ? validGroups.filter(([a, b]) => a.role !== b.role)
        : validGroups
      const choices = (allowSubstitution ? validGroups : balancedGroups)
        .sort((a, b) => {
          const groupScore = (group: Staff[]) => group.reduce((score, person) =>
            score + workCount[person.id] + (shift === 'N' ? nightCount[person.id] * 3 : 0), 0) +
            (shift !== 'S' && group.length === 2 && group[0].role === group[1].role ? 1000 : 0)
          return groupScore(a) - groupScore(b)
        })
        .slice(0, 16)

      choices.forEach((group) => {
        group.forEach((person) => {
          picked.add(person.id)
          current.push({ person, shift })
        })
        buildShift(shiftIndex + 1)
        current.splice(-group.length)
        group.forEach((person) => picked.delete(person.id))
      })
    }
    buildShift(0)
    return plans
  }

  const search = (day: number, allowSubstitution: boolean) => {
    if (Date.now() >= deadline || solutions >= 40) return
    if (day > bestDepth) {
      bestDepth = day
      bestPartial = cloneSchedule()
    }
    if (day > totalDays) {
      solutions += 1
      const score = finalScore()
      if (score < bestScore) {
        bestScore = score
        bestSchedule = cloneSchedule()
      }
      return
    }

    const weekend = [0, 6].includes(new Date(year, month, day).getDay())
    const plans = makeDayPlans(day, allowSubstitution)
    for (const plan of plans) {
      if (Date.now() >= deadline || solutions >= 40) break
      plan.forEach(({ person, shift }) => {
        result[person.id][day] = shift
        workCount[person.id] += 1
        if (shift === 'N') nightCount[person.id] += 1
        if (weekend) weekendCount[person.id] += 1
      })
      staff.forEach((person) => {
        if (!result[person.id][day]) result[person.id][day] = 'O'
      })
      search(day + 1, allowSubstitution)
      staff.forEach((person) => {
        const shift = result[person.id][day]
        if (isWork(shift)) {
          workCount[person.id] -= 1
          if (shift === 'N') nightCount[person.id] -= 1
          if (weekend) weekendCount[person.id] -= 1
        }
        if (!person.vacations.includes(day)) delete result[person.id][day]
      })
    }
  }

  search(1, false)
  if (!bestSchedule) {
    deadline = Date.now() + 700
    solutions = 0
    bestDepth = 0
    bestPartial = null
    search(1, true)
  }
  const output = bestSchedule || bestPartial || result
  staff.forEach((person) => {
    for (let day = 1; day <= totalDays; day += 1) {
      if (!output[person.id][day]) output[person.id][day] = person.vacations.includes(day) ? 'V' : 'O'
    }
  })
  return output
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
  const [specialNeeds, setSpecialNeeds] = useState<Record<number, number>>(() => {
    const saved = localStorage.getItem('nurse-scheduler-special-needs')
    return saved ? JSON.parse(saved) : {}
  })
  const [schedule, setSchedule] = useState<Schedule>(() => makeSchedule(staff, year, month, specialNeeds))
  const [newName, setNewName] = useState('')
  const [newRole, setNewRole] = useState<Role>('junior')
  const [selectedStaff, setSelectedStaff] = useState(staff[0]?.id || '')
  const [vacationDay, setVacationDay] = useState('')
  const [specialDay, setSpecialDay] = useState('')
  const [specialCount, setSpecialCount] = useState(1)
  const [toast, setToast] = useState('')
  const totalDays = daysInMonth(year, month)
  const firstWeekday = new Date(year, month, 1).getDay()

  useEffect(() => localStorage.setItem('nurse-scheduler-staff', JSON.stringify(staff)), [staff])
  useEffect(() => localStorage.setItem('nurse-scheduler-special-needs', JSON.stringify(specialNeeds)), [specialNeeds])

  const monthTitle = `${year}년 ${month + 1}월`
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
  const uncoveredDays = useMemo(() => Array.from({ length: totalDays }, (_, index) => index + 1)
    .filter((day) => (['D', 'E', 'N'] as const).some((shift) =>
      staff.filter((person) => schedule[person.id]?.[day] === shift).length !== 2,
    ) || staff.filter((person) => schedule[person.id]?.[day] === 'S').length !== (specialNeeds[day] || 0)),
  [schedule, specialNeeds, staff, totalDays])
  const algorithmIssues = useMemo(
    () => validateSchedule(schedule, staff, totalDays, specialNeeds),
    [schedule, specialNeeds, staff, totalDays],
  )
  const roleSubstitutions = useMemo(() => Array.from({ length: totalDays }, (_, index) => index + 1)
    .flatMap((day) => (['D', 'E', 'N'] as const).flatMap((shift) => {
      const workers = staff.filter((person) => schedule[person.id]?.[day] === shift)
      return workers.length === 2 && workers[0].role === workers[1].role ? [`${day}일 ${shift}`] : []
    })), [schedule, staff, totalDays])

  const changeMonth = (offset: number) => {
    const next = new Date(year, month + offset, 1)
    setYear(next.getFullYear())
    setMonth(next.getMonth())
    setSchedule(makeSchedule(staff, next.getFullYear(), next.getMonth(), specialNeeds))
  }

  const generate = () => {
    const next = makeSchedule(staff, year, month, specialNeeds)
    const issues = validateSchedule(next, staff, totalDays, specialNeeds)
    setSchedule(next)
    setToast(issues.length
      ? `검증에서 ${issues.length}개 문제를 발견했어요. 달력 위 안내를 확인해 주세요.`
      : '전체 규칙 검증을 통과한 최적 근무표를 만들었어요.')
    window.setTimeout(() => setToast(''), 2600)
  }

  const addStaff = () => {
    const name = newName.trim()
    if (!name) return
    const person: Staff = { id: crypto.randomUUID(), name, role: newRole, vacations: [] }
    const next = [...staff, person]
    setStaff(next)
    setSelectedStaff(person.id)
    setNewName('')
    setSchedule(makeSchedule(next, year, month, specialNeeds))
  }

  const removeStaff = (id: string) => {
    const next = staff.filter((person) => person.id !== id)
    setStaff(next)
    setSelectedStaff(next[0]?.id || '')
    setSchedule(makeSchedule(next, year, month, specialNeeds))
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
    setSchedule(makeSchedule(next, year, month, specialNeeds))
    setVacationDay('')
  }

  const removeVacation = (personId: string, day: number) => {
    const next = staff.map((person) => person.id === personId
      ? { ...person, vacations: person.vacations.filter((vacation) => vacation !== day) }
      : person)
    setStaff(next)
    setSchedule(makeSchedule(next, year, month, specialNeeds))
  }

  const changeRole = (id: string, role: Role) => {
    const next = staff.map((person) => person.id === id ? { ...person, role } : person)
    setStaff(next)
    setSchedule(makeSchedule(next, year, month, specialNeeds))
  }

  const addSpecialDay = () => {
    const day = Number(specialDay)
    if (!day || day < 1 || day > totalDays) {
      setToast(`1일부터 ${totalDays}일 사이의 S/P 날짜를 입력해 주세요.`)
      window.setTimeout(() => setToast(''), 2600)
      return
    }
    const next = { ...specialNeeds, [day]: specialCount }
    setSpecialNeeds(next)
    setSchedule(makeSchedule(staff, year, month, next))
    setSpecialDay('')
  }

  const removeSpecialDay = (day: number) => {
    const next = { ...specialNeeds }
    delete next[day]
    setSpecialNeeds(next)
    setSchedule(makeSchedule(staff, year, month, next))
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
    context.fillText(`D·E·N 각 2명 · S/P 지정 근무 · 생성일 ${new Date().toLocaleDateString('ko-KR')}`, margin, 158)

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
          <button className="download" onClick={downloadScheduleImage}>↓ 이미지 저장</button>
          <button className="generate" onClick={generate}><span>✦</span> 근무표 자동 생성</button>
        </div>
      </header>

      <section className="intro">
        <div>
          <p className="eyebrow">MONTHLY SCHEDULE</p>
          <h1>사무부 원무팀<br /><em>근무표 만들기</em></h1>
          <p className="intro-copy">직원과 휴가를 등록하면 원무팀 근무 규칙을 지켜<br />한 달 스케줄을 자동으로 완성해 드려요.</p>
        </div>
        <div className="rules">
          <p>자동 적용 중인 규칙</p>
          <div className="rule-tags"><span>타임별 사수 1 + 부사수 1</span><span>연속 근무 최대 3일</span><span>불가 시 역할 상호 대체</span><span>S/P 09:00–17:00</span><span>N 다음 S/P 금지</span><span>N 최소 2일 · 최대 3일</span><span>휴가 전날 N 금지</span><span>N 다음은 N 또는 O</span><span>N → O → D 금지</span><span>근무일 균등 배정</span></div>
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
            {(['D', 'E', 'N'] as const).map((shift) => <div className="fixed-staff" key={shift}><span className={`shift-dot ${shift}`}>{shift}</span><strong>{shiftInfo[shift].label}</strong><span>사수 1 · 부사수 1</span><b>2명</b></div>)}
            <p className="role-count">현재 사수 {staff.filter((person) => person.role === 'senior').length}명 · 부사수 {staff.filter((person) => person.role === 'junior').length}명</p>
          </div>

          <div className="panel">
            <div className="panel-title"><div><span className="step">04</span><h2>S/P 지정</h2></div><b>09–17시</b></div>
            <label>날짜<div className="vacation-input"><input type="number" min="1" max={totalDays} value={specialDay} onChange={(e) => setSpecialDay(e.target.value)} placeholder="날짜 입력" /><span>일</span></div></label>
            <label>필요 인원<select value={specialCount} onChange={(e) => setSpecialCount(Number(e.target.value))}><option value={1}>1명</option><option value={2}>2명</option></select></label>
            <button className="secondary" onClick={addSpecialDay}>S/P 날짜 추가</button>
            <div className="special-list">{Object.entries(specialNeeds).sort(([a], [b]) => Number(a) - Number(b)).map(([day, count]) => <button key={day} onClick={() => removeSpecialDay(Number(day))}>{day}일 · {count}명 <b>×</b></button>)}</div>
          </div>
        </aside>

        <div className="calendar-card">
          {algorithmIssues.length > 0 && <div className="schedule-warning"><strong>규칙 검증 문제 {algorithmIssues.length}개</strong><span>{uncoveredDays.length > 0 ? ` · 편성 불가: ${uncoveredDays.slice(0, 8).map((day) => `${day}일`).join(', ')}` : ''}</span><p>{algorithmIssues.slice(0, 4).join(' · ')}{algorithmIssues.length > 4 ? ` 외 ${algorithmIssues.length - 4}개` : ''}</p></div>}
          {algorithmIssues.length === 0 && roleSubstitutions.length > 0 && <div className="substitution-notice"><strong>역할 대체 투입 {roleSubstitutions.length}회</strong><span>{roleSubstitutions.slice(0, 8).join(', ')}{roleSubstitutions.length > 8 ? ` 외 ${roleSubstitutions.length - 8}회` : ''}</span><p>정상 사수·부사수 조합으로 편성이 불가능해 같은 역할 직원이 임시 투입됐습니다.</p></div>}
          <div className="calendar-head">
            <button onClick={() => changeMonth(-1)} aria-label="이전 달">‹</button>
            <div><h2>{monthTitle}</h2><p>날짜별 근무자를 한눈에 확인하세요</p></div>
            <button onClick={() => changeMonth(1)} aria-label="다음 달">›</button>
          </div>
          <div className="month-calendar">
            <div className="weekdays">{['일', '월', '화', '수', '목', '금', '토'].map((weekday, index) => <div key={weekday} className={index === 0 ? 'sun' : index === 6 ? 'sat' : ''}>{weekday}</div>)}</div>
            <div className="calendar-grid">
              {Array.from({ length: firstWeekday }, (_, index) => <div className="day-cell empty" key={`empty-${index}`} />)}
              {Array.from({ length: totalDays }, (_, index) => {
                const day = index + 1
                const weekday = new Date(year, month, day).getDay()
                return <article className="day-cell" key={day}>
                  <div className={`day-number ${weekday === 0 ? 'sun' : weekday === 6 ? 'sat' : ''}`}>{day}</div>
                  <div className="day-shifts">
                    {(['D', 'E', 'N'] as const).map((shift) => {
                      const workers = staff.filter((person) => schedule[person.id]?.[day] === shift)
                      return <div className={`day-shift shift-${shift}`} key={shift}>
                        <span>{shift}</span>
                        <div>{workers.map((person) => <b className={person.role} key={person.id} title={person.role === 'senior' ? '사수' : '부사수'}>{person.name.length === 3 ? person.name.slice(1) : person.name}</b>)}</div>
                      </div>
                    })}
                    {(specialNeeds[day] || 0) > 0 && <div className="day-shift shift-S">
                      <span>S</span>
                      <div>{staff.filter((person) => schedule[person.id]?.[day] === 'S').map((person) => <b className={person.role} key={person.id} title="S/P 09:00–17:00">{person.name.length === 3 ? person.name.slice(1) : person.name}</b>)}</div>
                    </div>}
                  </div>
                  {staff.some((person) => schedule[person.id]?.[day] === 'V') && <div className="day-vacation">휴가 {staff.filter((person) => schedule[person.id]?.[day] === 'V').map((person) => person.name.length === 3 ? person.name.slice(1) : person.name).join(' · ')}</div>}
                </article>
              })}
            </div>
          </div>
          <div className="summary">
            <div className="summary-title"><div><strong>직원별 월간 근무 집계</strong><p>근무 종류별 일수와 전체 근무일을 확인하세요.</p></div><span>{monthTitle}</span></div>
            <div className="summary-grid">
              {stats.map((stat) => {
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
        </div>
      </section>
      <footer>이대목동병원 사무부 원무팀 · 모든 근무 정보는 현재 브라우저에만 저장됩니다.</footer>
      {toast && <div className="toast">{toast}</div>}
    </main>
  )
}

export default App
