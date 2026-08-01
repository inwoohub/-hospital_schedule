type Shift = 'D' | 'E' | 'N' | 'S' | 'O' | 'V'
type WorkShift = 'D' | 'E' | 'N' | 'S'
type Role = 'senior' | 'junior'
export type Staff = { id: string; name: string; role: Role; vacations: number[] }
export type Schedule = Record<string, Record<number, Shift>>
export type SchedulingRules = {
  rolePairing: boolean
  minimumRotatingRun: boolean
  dayEveningBalance: boolean
  maxConsecutiveWork: boolean
  specialBalance: boolean
  nightBalance: boolean
  nightRunLength: boolean
  noNightBeforeVacation: boolean
  nightFollowup: boolean
  noNightOffDay: boolean
  workBalance: boolean
}

export const DEFAULT_SCHEDULING_RULES: SchedulingRules = {
  rolePairing: true,
  minimumRotatingRun: true,
  dayEveningBalance: true,
  maxConsecutiveWork: true,
  specialBalance: true,
  nightBalance: true,
  nightRunLength: true,
  noNightBeforeVacation: true,
  nightFollowup: true,
  noNightOffDay: true,
  workBalance: true,
}

export const RULE_LABELS: Record<keyof SchedulingRules, string> = {
  rolePairing: 'D/E/N 사수 최소 1명',
  minimumRotatingRun: 'D·E·N 최소 2일 연속',
  dayEveningBalance: 'D/E 횟수 균형 우선',
  maxConsecutiveWork: '연속 근무 최대 4일',
  specialBalance: 'S/P 횟수 균등 우선',
  nightBalance: 'N 횟수 차이 최대 1회',
  nightRunLength: 'N 최소 2일 · 최대 3일',
  noNightBeforeVacation: '휴가 전날 N 금지',
  nightFollowup: 'N 다음은 N 또는 O',
  noNightOffDay: 'N → O → D 금지',
  workBalance: '전체 근무 차이 최대 1일',
}

export const normalizeSchedulingRules = (rules?: Partial<SchedulingRules>): SchedulingRules => ({
  ...DEFAULT_SCHEDULING_RULES,
  ...rules,
  rolePairing: true,
})

export type ScheduleSearchOptions = {
  attemptDurationMs?: number
  maxAttempts?: number
  maxStagnantAttempts?: number
}

export type ScheduleSearchResult = {
  schedule: Schedule | null
  attempts: number
  furthestDay: number
  stoppedForNoProgress: boolean
  reason: string
  blockingIssues: string[]
}

const daysInMonth = (year: number, month: number) =>
  new Date(year, month + 1, 0).getDate()

const isWork = (shift?: Shift) => shift === 'D' || shift === 'E' || shift === 'N' || shift === 'S'
const isRotatingShift = (shift?: Shift): shift is 'D' | 'E' | 'N' =>
  shift === 'D' || shift === 'E' || shift === 'N'

export function validateSchedule(
  schedule: Schedule,
  staff: Staff[],
  totalDays: number,
  specialNeeds: Record<number, number>,
  requestedRules: Partial<SchedulingRules> = DEFAULT_SCHEDULING_RULES,
) {
  const rules = normalizeSchedulingRules(requestedRules)
  const issues: string[] = []
  for (let day = 1; day <= totalDays; day += 1) {
    ;(['D', 'E', 'N'] as const).forEach((shift) => {
      const workers = staff.filter((person) => schedule[person.id]?.[day] === shift)
      if (workers.length !== 2) issues.push(`${day}일 ${shift} ${workers.length}명`)
    })
    const specialWorkers = staff.filter((person) => schedule[person.id]?.[day] === 'S')
    if (specialWorkers.length !== (specialNeeds[day] || 0)) issues.push(`${day}일 S/P ${specialWorkers.length}명`)
    if ((specialNeeds[day] || 0) > 0 && !specialWorkers.some((person) => person.role === 'senior')) {
      issues.push(`${day}일 S/P 사수 미배치`)
    }
    if (rules.rolePairing) {
      ;(['D', 'E', 'N'] as const).forEach((shift) => {
        const workers = staff.filter((person) => schedule[person.id]?.[day] === shift)
        if (workers.length === 2 && !workers.some((person) => person.role === 'senior')) {
          issues.push(`${day}일 ${shift} 사수 미배치`)
        }
      })
    }
  }
  staff.forEach((person) => {
    let nightRun = 0
    let workRun = 0
    let rotatingRun = 0
    let rotatingShift: 'D' | 'E' | 'N' | null = null
    for (let day = 1; day <= totalDays; day += 1) {
      const shift = schedule[person.id]?.[day]
      const prev = schedule[person.id]?.[day - 1]
      const prev2 = schedule[person.id]?.[day - 2]
      if (person.vacations.includes(day) && shift !== 'V') issues.push(`${day}일 ${person.name} 휴가 미반영`)
      if (rules.nightFollowup && prev === 'N' && shift !== 'N' && shift !== 'O') {
        issues.push(`${day}일 ${person.name} N 다음 ${shift}`)
      }
      if (rules.noNightOffDay && shift === 'D' && prev === 'O' && prev2 === 'N') {
        issues.push(`${day}일 ${person.name} N-O-D`)
      }
      if (rules.noNightBeforeVacation && shift === 'N' && person.vacations.includes(day + 1)) {
        issues.push(`${day}일 ${person.name} 휴가 전날 N`)
      }
      if (rules.minimumRotatingRun && isRotatingShift(shift)) {
        if (shift === rotatingShift) {
          rotatingRun += 1
        } else {
          if (rotatingShift && rotatingRun === 1) {
            issues.push(`${day - 1}일 ${person.name} ${rotatingShift} 1일 단독 근무`)
          }
          rotatingShift = shift
          rotatingRun = 1
        }
      } else if (rules.minimumRotatingRun) {
        if (rotatingShift && rotatingRun === 1) {
          issues.push(`${day - 1}일 ${person.name} ${rotatingShift} 1일 단독 근무`)
        }
        rotatingShift = null
        rotatingRun = 0
      }
      if (rules.nightRunLength && shift === 'N') {
        nightRun += 1
      } else if (rules.nightRunLength) {
        if (nightRun === 1 || nightRun > 3) issues.push(`${day - 1}일 ${person.name} N ${nightRun}일 연속`)
        nightRun = 0
      }
      if (isWork(shift)) {
        workRun += 1
        if (rules.maxConsecutiveWork && workRun >= 5) {
          issues.push(`${day}일 ${person.name} ${workRun}일 연속 근무`)
        }
      } else {
        workRun = 0
      }
    }
    if (rules.nightRunLength && (nightRun === 1 || nightRun > 3)) {
      issues.push(`${totalDays}일 ${person.name} N ${nightRun}일 연속`)
    }
    if (rules.minimumRotatingRun && rotatingShift && rotatingRun === 1) {
      issues.push(`${totalDays}일 ${person.name} ${rotatingShift} 1일 단독 근무`)
    }
  })
  const nightTotals = staff.map((person) =>
    Object.values(schedule[person.id] || {}).filter((shift) => shift === 'N').length)
  if (rules.nightBalance && nightTotals.length > 1) {
    const minNight = Math.min(...nightTotals)
    const maxNight = Math.max(...nightTotals)
    if (maxNight - minNight > 1) {
      issues.push(`나이트 횟수 차이 ${maxNight - minNight}회 (${minNight}회–${maxNight}회)`)
    }
  }
  if (rules.dayEveningBalance) {
    ;(['D', 'E'] as const).forEach((shift) => {
      const totals = staff.map((person) =>
        Object.values(schedule[person.id] || {}).filter((assigned) => assigned === shift).length)
      if (totals.length > 1) {
        const minimum = Math.min(...totals)
        const maximum = Math.max(...totals)
        if (maximum - minimum > 2) {
          issues.push(`${shift === 'D' ? '데이' : '이브닝'} 횟수 차이 ${maximum - minimum}회 (${minimum}회–${maximum}회)`)
        }
      }
    })
  }
  const workTotals = staff.map((person) =>
    Object.values(schedule[person.id] || {}).filter(isWork).length)
  if (rules.workBalance && workTotals.length > 1) {
    const minWork = Math.min(...workTotals)
    const maxWork = Math.max(...workTotals)
    if (maxWork - minWork > 1) {
      issues.push(`전체 근무일수 차이 ${maxWork - minWork}일 (${minWork}일–${maxWork}일)`)
    }
  }
  return [...new Set(issues)]
}

export function searchSchedule(
  staff: Staff[],
  year: number,
  month: number,
  specialNeeds: Record<number, number>,
  requestedRules: Partial<SchedulingRules> = DEFAULT_SCHEDULING_RULES,
  options: ScheduleSearchOptions = {},
): ScheduleSearchResult {
  const rules = normalizeSchedulingRules(requestedRules)
  const totalDays = daysInMonth(year, month)
  const attemptDurationMs = options.attemptDurationMs ?? 900
  const maxAttempts = options.maxAttempts ?? 48
  const maxStagnantAttempts = options.maxStagnantAttempts ?? 8
  for (let day = 1; day <= totalDays; day += 1) {
    const available = staff.filter((person) => !person.vacations.includes(day))
    if (available.length < 6 + (specialNeeds[day] || 0)) {
      return {
        schedule: null,
        attempts: 0,
        furthestDay: day - 1,
        stoppedForNoProgress: false,
        reason: `${day}일 필수 인원을 채울 수 없습니다.`,
        blockingIssues: [`${day}일 휴가자를 제외한 근무 가능 인원이 필수 인원보다 부족합니다.`],
      }
    }
    if ((specialNeeds[day] || 0) > 0 && !available.some((person) => person.role === 'senior')) {
      return {
        schedule: null,
        attempts: 0,
        furthestDay: day - 1,
        stoppedForNoProgress: false,
        reason: `${day}일 S/P 사수를 배치할 수 없습니다.`,
        blockingIssues: [`${day}일 S/P에 배치할 수 있는 사수가 없습니다.`],
      }
    }
    if (rules.rolePairing) {
      const seniorCount = available.filter((person) => person.role === 'senior').length
      const requiredSeniors = 3 + ((specialNeeds[day] || 0) > 0 ? 1 : 0)
      if (seniorCount < requiredSeniors) {
        return {
          schedule: null,
          attempts: 0,
          furthestDay: day - 1,
          stoppedForNoProgress: false,
          reason: `${day}일 D/E/N과 S/P에 필요한 사수 인원이 부족합니다.`,
          blockingIssues: [`${day}일 D/E/N 각 사수 1명과 S/P 사수를 동시에 배치할 수 없습니다.`],
        }
      }
    }
  }
  const result: Schedule = Object.fromEntries(staff.map((person) => [person.id, {}]))
  const workCount = Object.fromEntries(staff.map((person) => [person.id, 0]))
  const dayCount = Object.fromEntries(staff.map((person) => [person.id, 0]))
  const eveningCount = Object.fromEntries(staff.map((person) => [person.id, 0]))
  const nightCount = Object.fromEntries(staff.map((person) => [person.id, 0]))
  const specialCount = Object.fromEntries(staff.map((person) => [person.id, 0]))
  const weekendCount = Object.fromEntries(staff.map((person) => [person.id, 0]))
  const totalAssignments = Array.from({ length: totalDays }, (_, index) =>
    6 + (specialNeeds[index + 1] || 0)).reduce((sum, count) => sum + count, 0)
  const idealMinWork = staff.length ? Math.floor(totalAssignments / staff.length) : 0
  const idealMaxWork = staff.length ? Math.ceil(totalAssignments / staff.length) : 0
  const idealMinNight = staff.length ? Math.floor((totalDays * 2) / staff.length) : 0
  const idealMaxNight = staff.length ? Math.ceil((totalDays * 2) / staff.length) : 0
  const maxWorkLimit = rules.workBalance ? idealMaxWork : totalDays
  let deadline = 0
  let bestSchedule: Schedule | null = null
  let bestScore = Number.POSITIVE_INFINITY
  let bestSpread = Number.POSITIVE_INFINITY
  let bestDaySpread = Number.POSITIVE_INFINITY
  let bestEveningSpread = Number.POSITIVE_INFINITY
  let bestNightSpread = Number.POSITIVE_INFINITY
  let bestSpecialSpread = Number.POSITIVE_INFINITY
  let solutions = 0
  let searchAttempt = 0
  let furthestDay = 0
  let bestRejectedIssues: string[] = []

  staff.forEach((person) => {
    person.vacations.forEach((day) => {
      if (day <= totalDays) result[person.id][day] = 'V'
    })
  })

  const canAssign = (person: Staff, day: number, shift: WorkShift) => {
    if (result[person.id][day]) return false
    if (workCount[person.id] >= maxWorkLimit) return false
    const prev = result[person.id][day - 1]
    const prev2 = result[person.id][day - 2]
    const prev3 = result[person.id][day - 3]
    const prev4 = result[person.id][day - 4]
    if (rules.maxConsecutiveWork && isWork(prev) && isWork(prev2) && isWork(prev3) && isWork(prev4)) return false
    if (rules.minimumRotatingRun && isRotatingShift(prev) && prev2 !== prev && shift !== prev) return false
    if (rules.minimumRotatingRun && isRotatingShift(shift) && prev !== shift && workCount[person.id] + 2 > maxWorkLimit) return false
    if (rules.minimumRotatingRun && isRotatingShift(shift) && prev !== shift && person.vacations.includes(day + 1)) return false
    if (rules.minimumRotatingRun && isRotatingShift(shift) && prev !== shift && day === totalDays) return false
    if (rules.noNightBeforeVacation && shift === 'N' && person.vacations.includes(day + 1)) return false
    if (rules.nightRunLength && shift === 'N' && prev !== 'N' && person.vacations.includes(day + 1)) return false
    if (rules.nightRunLength && shift === 'N' && prev !== 'N' && day === totalDays) return false
    if (rules.nightRunLength && shift === 'N' && prev !== 'N' && workCount[person.id] + 2 > maxWorkLimit) return false
    if (rules.nightBalance && shift === 'N' && nightCount[person.id] >= idealMaxNight) return false
    if (rules.nightBalance && rules.nightRunLength && shift === 'N' && prev !== 'N' && nightCount[person.id] + 2 > idealMaxNight) return false
    if (rules.nightRunLength && shift === 'N' && prev === 'N' && prev2 === 'N' && prev3 === 'N') return false
    if (rules.nightFollowup && prev === 'N' && shift !== 'N') return false
    if (rules.nightFollowup && shift === 'D' && prev === 'N') return false
    if (rules.noNightOffDay && shift === 'D' && prev === 'O' && prev2 === 'N') return false
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

  const workSpread = () => {
    const counts = staff.map((person) => workCount[person.id])
    return counts.length ? Math.max(...counts) - Math.min(...counts) : 0
  }

  const nightSpread = () => {
    const counts = staff.map((person) => nightCount[person.id])
    return counts.length ? Math.max(...counts) - Math.min(...counts) : 0
  }

  const daySpread = () => {
    const counts = staff.map((person) => dayCount[person.id])
    return counts.length ? Math.max(...counts) - Math.min(...counts) : 0
  }

  const eveningSpread = () => {
    const counts = staff.map((person) => eveningCount[person.id])
    return counts.length ? Math.max(...counts) - Math.min(...counts) : 0
  }

  const specialSpread = () => {
    const counts = staff.map((person) => specialCount[person.id])
    return counts.length ? Math.max(...counts) - Math.min(...counts) : 0
  }

  const finalScore = () =>
    variance(staff.map((person) => workCount[person.id])) * (rules.workBalance ? 500 : 4) +
    variance(staff.map((person) => dayCount[person.id])) * (rules.dayEveningBalance ? 160 : 2) +
    variance(staff.map((person) => eveningCount[person.id])) * (rules.dayEveningBalance ? 160 : 2) +
    variance(staff.map((person) => nightCount[person.id])) * (rules.nightBalance ? 300 : 4) +
    variance(staff.map((person) => specialCount[person.id])) * (rules.specialBalance ? 60 : 1) +
    variance(staff.map((person) => weekendCount[person.id])) * 5

  const makeDayPlans = (day: number) => {
    const dayShifts: Array<{ shift: WorkShift; count: number }> = [
      ...(specialNeeds[day] ? [{ shift: 'S' as WorkShift, count: specialNeeds[day] }] : []),
      { shift: 'N', count: 2 },
      { shift: 'D', count: 2 },
      { shift: 'E', count: 2 },
    ]
    const plans: Array<Array<{ person: Staff; shift: WorkShift }>> = []
    const picked = new Set<string>()
    const current: Array<{ person: Staff; shift: WorkShift }> = []

    const buildShift = (shiftIndex: number) => {
      if (plans.length >= 80) return
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
      const roleEligibleGroups = shift === 'S'
        ? groups.filter((group) => group.some((person) => person.role === 'senior'))
        : groups
      const mustContinueShift = rules.minimumRotatingRun && isRotatingShift(shift)
        ? staff.filter((person) =>
          result[person.id][day - 1] === shift && result[person.id][day - 2] !== shift,
        ).map((person) => person.id)
        : []
      const requiredGroups = roleEligibleGroups.filter((group) =>
        mustContinueShift.every((id) => group.some((person) => person.id === id)),
      )
      const validGroups = rules.minimumRotatingRun && isRotatingShift(shift) ? requiredGroups : roleEligibleGroups
      const seniorCoveredGroups = shift !== 'S' && count === 2
        ? validGroups.filter((group) => group.some((person) => person.role === 'senior'))
        : validGroups
      const choices = (rules.rolePairing ? seniorCoveredGroups : validGroups)
        .sort((a, b) => {
          const groupScore = (group: Staff[]) => group.reduce((score, person) =>
            score + (workCount[person.id] + 1) ** 2 * 4 +
              (shift === 'N' ? (nightCount[person.id] + 1) ** 2 * 24 : 0) +
              (shift === 'S' ? (specialCount[person.id] + 1) ** 2 * 80 : 0) +
              ((staff.indexOf(person) + 1) * (searchAttempt + 5) * 11 + day * 7) % 23, 0) +
            (shift !== 'S' && group.length === 2 && !group.some((person) => person.role === 'senior') ? 120 : 0)
          return groupScore(a) - groupScore(b)
        })
        .slice(0, 28)

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

  const search = (day: number) => {
    if (Date.now() >= deadline || solutions >= 1) return
    furthestDay = Math.max(furthestDay, Math.min(day, totalDays))
    if (day > totalDays) {
      const spread = workSpread()
      const currentDaySpread = daySpread()
      const currentEveningSpread = eveningSpread()
      const currentNightSpread = nightSpread()
      const currentSpecialSpread = specialSpread()
      const candidateIssues = validateSchedule(cloneSchedule(), staff, totalDays, specialNeeds, {
        ...rules,
        dayEveningBalance: false,
        specialBalance: false,
      })
      if (candidateIssues.length > 0) {
        if (!bestRejectedIssues.length || candidateIssues.length < bestRejectedIssues.length) {
          bestRejectedIssues = candidateIssues
        }
        return
      }
      solutions += 1
      const score = finalScore()
      const currentDayEveningSpread = currentDaySpread + currentEveningSpread
      const bestDayEveningSpread = bestDaySpread + bestEveningSpread
      if (
        spread < bestSpread ||
        (spread === bestSpread && currentNightSpread < bestNightSpread) ||
        (spread === bestSpread && currentNightSpread === bestNightSpread && currentDayEveningSpread < bestDayEveningSpread) ||
        (spread === bestSpread && currentNightSpread === bestNightSpread && currentDayEveningSpread === bestDayEveningSpread && currentSpecialSpread < bestSpecialSpread) ||
        (spread === bestSpread && currentNightSpread === bestNightSpread && currentDayEveningSpread === bestDayEveningSpread && currentSpecialSpread === bestSpecialSpread && score < bestScore)
      ) {
        bestSpread = spread
        bestDaySpread = currentDaySpread
        bestEveningSpread = currentEveningSpread
        bestNightSpread = currentNightSpread
        bestSpecialSpread = currentSpecialSpread
        bestScore = score
        bestSchedule = cloneSchedule()
      }
      return
    }

    const weekend = [0, 6].includes(new Date(year, month, day).getDay())
    const plans = makeDayPlans(day)
    for (const plan of plans) {
      if (Date.now() >= deadline || solutions >= 1) break
      plan.forEach(({ person, shift }) => {
        result[person.id][day] = shift
        workCount[person.id] += 1
        if (shift === 'D') dayCount[person.id] += 1
        if (shift === 'E') eveningCount[person.id] += 1
        if (shift === 'N') nightCount[person.id] += 1
        if (shift === 'S') specialCount[person.id] += 1
        if (weekend) weekendCount[person.id] += 1
      })
      staff.forEach((person) => {
        if (!result[person.id][day]) result[person.id][day] = 'O'
      })
      const remainingWorkSlots = Array.from({ length: totalDays - day }, (_, index) =>
        6 + (specialNeeds[day + index + 1] || 0)).reduce((sum, count) => sum + count, 0)
      const remainingNightSlots = (totalDays - day) * 2
      const workDeficit = staff.reduce((sum, person) =>
        sum + Math.max(0, idealMinWork - workCount[person.id]), 0)
      const nightDeficit = staff.reduce((sum, person) =>
        sum + Math.max(0, idealMinNight - nightCount[person.id]), 0)
      if (
        (!rules.workBalance || workDeficit <= remainingWorkSlots) &&
        (!rules.nightBalance || nightDeficit <= remainingNightSlots)
      ) {
        search(day + 1)
      }
      staff.forEach((person) => {
        const shift = result[person.id][day]
        if (isWork(shift)) {
          workCount[person.id] -= 1
          if (shift === 'D') dayCount[person.id] -= 1
          if (shift === 'E') eveningCount[person.id] -= 1
          if (shift === 'N') nightCount[person.id] -= 1
          if (shift === 'S') specialCount[person.id] -= 1
          if (weekend) weekendCount[person.id] -= 1
        }
        if (!person.vacations.includes(day)) delete result[person.id][day]
      })
    }
  }

  let lastProgressDay = 0
  let stagnantAttempts = 0
  while (!bestSchedule && searchAttempt < maxAttempts && stagnantAttempts < maxStagnantAttempts) {
    searchAttempt += 1
    deadline = Date.now() + attemptDurationMs
    solutions = 0
    search(1)
    if (furthestDay > lastProgressDay) {
      lastProgressDay = furthestDay
      stagnantAttempts = 0
    } else {
      stagnantAttempts += 1
    }
  }
  if (!bestSchedule) {
    return {
      schedule: null,
      attempts: searchAttempt,
      furthestDay,
      stoppedForNoProgress: stagnantAttempts >= maxStagnantAttempts,
      reason: furthestDay > 0
        ? `${furthestDay}일까지 탐색한 뒤 같은 지점에서 가능한 조합을 더 찾지 못했습니다.`
        : '선택한 규칙으로 가능한 첫 배치를 찾지 못했습니다.',
      blockingIssues: bestRejectedIssues,
    }
  }
  const output = bestSchedule as Schedule
  staff.forEach((person) => {
    for (let day = 1; day <= totalDays; day += 1) {
      if (!output[person.id][day]) output[person.id][day] = person.vacations.includes(day) ? 'V' : 'O'
    }
  })

  const rebalance = (schedule: Schedule) => {
    const countWork = (personId: string) =>
      Object.values(schedule[personId]).filter(isWork).length
    const spread = () => {
      const counts = staff.map((person) => countWork(person.id))
      return counts.length ? Math.max(...counts) - Math.min(...counts) : 0
    }
    const imbalance = () => {
      const counts = staff.map((person) => countWork(person.id))
      if (!counts.length) return 0
      const average = counts.reduce((sum, count) => sum + count, 0) / counts.length
      return counts.reduce((sum, count) => sum + (count - average) ** 2, 0)
    }
    const rebalanceDeadline = Date.now() + 250

    const searchBalance = (depth: number): boolean => {
      if (spread() <= 1) return true
      if (Date.now() >= rebalanceDeadline || depth >= Math.min(staff.length, 6)) return false
      const ordered = [...staff].sort((a, b) => countWork(a.id) - countWork(b.id))
      const currentImbalance = imbalance()

      for (const low of ordered) {
        for (const high of [...ordered].reverse()) {
          if (countWork(high.id) - countWork(low.id) <= 1) continue
          for (let day = 1; day <= totalDays; day += 1) {
            const shift = schedule[high.id][day]
            if (!isWork(shift)) continue
            const transferOptions: number[][] = [[day]]
            if (isRotatingShift(shift) && schedule[high.id][day - 1] !== shift) {
              let blockEnd = day
              while (blockEnd < totalDays && schedule[high.id][blockEnd + 1] === shift) blockEnd += 1
              if (blockEnd > day) {
                transferOptions.push(Array.from({ length: blockEnd - day + 1 }, (_, index) => day + index))
              }
            }

            for (const transferDays of transferOptions) {
              if (transferDays.some((transferDay) => schedule[low.id][transferDay] !== 'O')) continue
              transferDays.forEach((transferDay) => {
                schedule[high.id][transferDay] = 'O'
                schedule[low.id][transferDay] = shift
              })
              const isValid = imbalance() < currentImbalance &&
                validateSchedule(schedule, staff, totalDays, specialNeeds, {
                  ...rules,
                  workBalance: false,
                  dayEveningBalance: false,
                }).length === 0
              if (isValid && searchBalance(depth + 1)) return true
              transferDays.forEach((transferDay) => {
                schedule[high.id][transferDay] = shift
                schedule[low.id][transferDay] = 'O'
              })
            }
          }
        }
      }
      return false
    }
    searchBalance(0)
    return schedule
  }

  const rebalanceDayEvening = (schedule: Schedule) => {
    type BalanceState = {
      lastShift: Array<'D' | 'E' | null>
      runLength: number[]
      dayCounts: number[]
      eveningCounts: number[]
      dayWorkers: Array<[number, number]>
      score: number
    }
    const pools = Array.from({ length: totalDays }, (_, index) => {
      const day = index + 1
      return staff.map((person, personIndex) => ({ person, personIndex }))
        .filter(({ person }) => schedule[person.id][day] === 'D' || schedule[person.id][day] === 'E')
        .map(({ personIndex }) => personIndex)
    })
    if (pools.some((pool) => pool.length !== 4)) return schedule

    const spread = (values: number[]) => Math.max(...values) - Math.min(...values)
    const finalMetric = (days: number[], evenings: number[]) =>
      Math.max(spread(days), spread(evenings)) * 10000 +
      (spread(days) + spread(evenings)) * 1000 + variance(days) + variance(evenings)
    const remainingAvailability = Array.from({ length: totalDays + 1 }, () =>
      Array(staff.length).fill(0) as number[])
    for (let day = totalDays - 1; day >= 0; day -= 1) {
      remainingAvailability[day] = [...remainingAvailability[day + 1]]
      pools[day].forEach((personIndex) => {
        remainingAvailability[day][personIndex] += 1
      })
    }
    const partialMetric = (days: number[], evenings: number[], remaining: number[]) => {
      const projectedDays = days.map((count, index) => count + remaining[index] / 2)
      const projectedEvenings = evenings.map((count, index) => count + remaining[index] / 2)
      return Math.max(spread(projectedDays), spread(projectedEvenings)) * 200 +
        variance(projectedDays) * 12 + variance(projectedEvenings) * 12 +
        projectedDays.reduce((sum, count, index) => sum + Math.abs(count - projectedEvenings[index]), 0)
    }
    let states: BalanceState[] = [{
      lastShift: Array(staff.length).fill(null),
      runLength: Array(staff.length).fill(0),
      dayCounts: Array(staff.length).fill(0),
      eveningCounts: Array(staff.length).fill(0),
      dayWorkers: [],
      score: 0,
    }]

    for (let day = 1; day <= totalDays; day += 1) {
      const pool = pools[day - 1]
      const combinations: Array<[number, number]> = []
      for (let first = 0; first < pool.length; first += 1) {
        for (let second = first + 1; second < pool.length; second += 1) {
          combinations.push([pool[first], pool[second]])
        }
      }
      const nextStates: BalanceState[] = []
      states.forEach((state) => {
        combinations.forEach((dayPair) => {
          const active = new Set(pool)
          const daySet = new Set(dayPair)
          const lastShift = [...state.lastShift]
          const runLength = [...state.runLength]
          const dayCounts = [...state.dayCounts]
          const eveningCounts = [...state.eveningCounts]
          let valid = true

          for (let index = 0; index < staff.length; index += 1) {
            if (!active.has(index)) {
              if (rules.minimumRotatingRun && lastShift[index] && runLength[index] === 1) valid = false
              lastShift[index] = null
              runLength[index] = 0
              continue
            }
            const nextShift: 'D' | 'E' = daySet.has(index) ? 'D' : 'E'
            if (rules.minimumRotatingRun && lastShift[index] && lastShift[index] !== nextShift && runLength[index] === 1) valid = false
            if (!lastShift[index] && nextShift === 'D') {
              const personSchedule = schedule[staff[index].id]
              if (
                rules.nightFollowup &&
                personSchedule[day - 1] === 'N'
              ) valid = false
              if (
                rules.noNightOffDay &&
                personSchedule[day - 1] === 'O' && personSchedule[day - 2] === 'N'
              ) valid = false
            }
            if (lastShift[index] === nextShift) runLength[index] += 1
            else runLength[index] = 1
            lastShift[index] = nextShift
            if (nextShift === 'D') dayCounts[index] += 1
            else eveningCounts[index] += 1
          }
          if (!valid) return
          nextStates.push({
            lastShift,
            runLength,
            dayCounts,
            eveningCounts,
            dayWorkers: [...state.dayWorkers, dayPair],
            score: partialMetric(dayCounts, eveningCounts, remainingAvailability[day]),
          })
        })
      })
      nextStates.sort((a, b) => a.score - b.score)
      states = nextStates.slice(0, 3200)
      if (!states.length) return schedule
    }

    const completeStates = rules.minimumRotatingRun
      ? states.filter((state) =>
        state.runLength.every((length, index) => !state.lastShift[index] || length !== 1))
      : states
    completeStates.sort((a, b) =>
      finalMetric(a.dayCounts, a.eveningCounts) - finalMetric(b.dayCounts, b.eveningCounts))
    const best = completeStates[0]
    if (!best) return schedule
    const originalLabels = pools.map((pool, index) => pool.map((personIndex) =>
      schedule[staff[personIndex].id][index + 1] as 'D' | 'E'))
    best.dayWorkers.forEach((dayPair, index) => {
      const day = index + 1
      const daySet = new Set(dayPair)
      pools[index].forEach((personIndex) => {
        schedule[staff[personIndex].id][day] = daySet.has(personIndex) ? 'D' : 'E'
      })
    })
    if (validateSchedule(schedule, staff, totalDays, specialNeeds, {
      ...rules,
      workBalance: false,
      dayEveningBalance: false,
    }).length > 0) {
      pools.forEach((pool, index) => pool.forEach((personIndex, poolIndex) => {
        schedule[staff[personIndex].id][index + 1] = originalLabels[index][poolIndex]
      }))
    }
    return schedule
  }

  if (!bestSchedule || (rules.nightBalance && bestNightSpread > 1)) {
    return {
      schedule: output,
      attempts: searchAttempt,
      furthestDay,
      stoppedForNoProgress: false,
      reason: '',
      blockingIssues: [],
    }
  }
  const workBalanced = rules.workBalance ? rebalance(output) : output
  return {
    schedule: rules.dayEveningBalance ? rebalanceDayEvening(workBalanced) : workBalanced,
    attempts: searchAttempt,
    furthestDay,
    stoppedForNoProgress: false,
    reason: '',
    blockingIssues: [],
  }
}
