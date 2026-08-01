import {
  normalizeSchedulingRules,
  validateSchedule,
  type FixedAssignments,
  type Schedule,
  type SchedulingRules,
  type Staff,
  type WorkShift,
} from './scheduler-core'

type Variable = { name: string; coef: number }
type LinearModel = {
  name: string
  objective: { direction: number; name: string; vars: Variable[] }
  subjectTo: Array<{
    name: string
    vars: Variable[]
    bnds: { type: number; ub: number; lb: number }
  }>
  bounds?: Array<{ name: string; type: number; ub: number; lb: number }>
  binaries?: string[]
  generals?: string[]
}
type HighsEngine = {
  solve: (model: string, options?: Record<string, string | number | boolean>) => {
    Status: string
    Columns: Record<string, unknown>
  }
}

export type MilpSolveStatus = 'feasible' | 'infeasible' | 'unknown'

export type MilpSolveResult = {
  status: MilpSolveStatus
  schedule: Schedule | null
  issues: string[]
  solveTimeMs: number
  detail: string
}

const WORK_SHIFTS: WorkShift[] = ['D', 'E', 'N', 'S']
const ROTATING_SHIFTS: WorkShift[] = ['D', 'E', 'N']
const MODEL_CONSTANTS = {
  GLP_MIN: 1,
  GLP_LO: 2,
  GLP_UP: 3,
  GLP_DB: 4,
  GLP_FX: 5,
}

const variableName = (personIndex: number, day: number, shift: WorkShift) =>
  `x_${personIndex}_${day}_${shift}`

const sumFor = (
  personIndex: number,
  totalDays: number,
  shifts: WorkShift[],
): Variable[] => {
  const variables: Variable[] = []
  for (let day = 1; day <= totalDays; day += 1) {
    for (const shift of shifts) {
      variables.push({ name: variableName(personIndex, day, shift), coef: 1 })
    }
  }
  return variables
}

export function buildScheduleModel(
  staff: Staff[],
  year: number,
  month: number,
  specialNeeds: Record<number, number>,
  requestedRules: Partial<SchedulingRules>,
  fixedAssignments: FixedAssignments = {},
): LinearModel {
  const glpk = MODEL_CONSTANTS
  const rules = normalizeSchedulingRules(requestedRules)
  const totalDays = new Date(year, month + 1, 0).getDate()
  const binaries: string[] = []
  const bounds: NonNullable<LinearModel['bounds']> = []
  const subjectTo: LinearModel['subjectTo'] = []

  const addConstraint = (
    name: string,
    variables: Variable[],
    type: number,
    lower = 0,
    upper = 0,
  ) => {
    subjectTo.push({
      name,
      vars: variables,
      bnds: { type, lb: lower, ub: upper },
    })
  }

  const addUpper = (name: string, variables: Variable[], upper: number) =>
    addConstraint(name, variables, glpk.GLP_UP, 0, upper)
  const addLower = (name: string, variables: Variable[], lower: number) =>
    addConstraint(name, variables, glpk.GLP_LO, lower, 0)
  const addFixed = (name: string, variables: Variable[], value: number) =>
    addConstraint(name, variables, glpk.GLP_FX, value, value)

  for (let personIndex = 0; personIndex < staff.length; personIndex += 1) {
    for (let day = 1; day <= totalDays; day += 1) {
      for (const shift of WORK_SHIFTS) {
        binaries.push(variableName(personIndex, day, shift))
      }
    }
  }

  // 사용자가 빈 달력에서 미리 선택한 근무는 반드시 해당 날짜·타임에 배치합니다.
  for (let day = 1; day <= totalDays; day += 1) {
    for (const shift of WORK_SHIFTS) {
      const fixedPeople = fixedAssignments[day]?.[shift] || []
      fixedPeople.forEach((personId, slotIndex) => {
        if (!personId) return
        const personIndex = staff.findIndex((person) => person.id === personId)
        if (personIndex < 0) return
        addFixed(
          `user_fixed_${day}_${shift}_${slotIndex}`,
          [{ name: variableName(personIndex, day, shift), coef: 1 }],
          1,
        )
      })
    }
    // 오프로 고정한 직원은 해당 날짜의 모든 근무 변수를 0으로 고정합니다.
    for (const personId of fixedAssignments[day]?.O || []) {
      if (!personId) continue
      const personIndex = staff.findIndex((person) => person.id === personId)
      if (personIndex < 0) continue
      addFixed(
        `user_fixed_${day}_O_${personIndex}`,
        WORK_SHIFTS.map((shift) => ({
          name: variableName(personIndex, day, shift),
          coef: 1,
        })),
        0,
      )
    }
  }

  // 한 직원은 하루에 한 근무만 가능하며, 휴가일은 모든 근무를 0으로 고정합니다.
  for (let personIndex = 0; personIndex < staff.length; personIndex += 1) {
    const person = staff[personIndex]
    for (let day = 1; day <= totalDays; day += 1) {
      const dailyWork = WORK_SHIFTS.map((shift) => ({
        name: variableName(personIndex, day, shift),
        coef: 1,
      }))
      if (person.vacations.includes(day)) {
        addFixed(`vac_${personIndex}_${day}`, dailyWork, 0)
      } else {
        addUpper(`one_${personIndex}_${day}`, dailyWork, 1)
      }
    }
  }

  // 매일 D/E/N 각 2명, 날짜별 S/P 인원을 정확히 채웁니다.
  for (let day = 1; day <= totalDays; day += 1) {
    for (const shift of ROTATING_SHIFTS) {
      addFixed(
        `coverage_${day}_${shift}`,
        staff.map((_, personIndex) => ({
          name: variableName(personIndex, day, shift),
          coef: 1,
        })),
        2,
      )
    }
    addFixed(
      `coverage_${day}_S`,
      staff.map((_, personIndex) => ({
        name: variableName(personIndex, day, 'S'),
        coef: 1,
      })),
      specialNeeds[day] || 0,
    )
  }

  const seniorIndexes = staff
    .map((person, personIndex) => person.role === 'senior' ? personIndex : -1)
    .filter((personIndex) => personIndex >= 0)

  // D/E/N에는 사수가 최소 1명, S/P가 있는 날에도 사수가 최소 1명입니다.
  for (let day = 1; day <= totalDays; day += 1) {
    for (const shift of ROTATING_SHIFTS) {
      addLower(
        `senior_${day}_${shift}`,
        seniorIndexes.map((personIndex) => ({
          name: variableName(personIndex, day, shift),
          coef: 1,
        })),
        1,
      )
    }
    if ((specialNeeds[day] || 0) > 0) {
      addLower(
        `senior_${day}_S`,
        seniorIndexes.map((personIndex) => ({
          name: variableName(personIndex, day, 'S'),
          coef: 1,
        })),
        1,
      )
    }
  }

  // 선택 규칙: D/E/N 단독 하루 근무를 막습니다. N 길이 규칙도 N 1일 근무를 막습니다.
  for (let personIndex = 0; personIndex < staff.length; personIndex += 1) {
    for (const shift of ROTATING_SHIFTS) {
      if (!rules.minimumRotatingRun && !(shift === 'N' && rules.nightRunLength)) continue
      for (let day = 1; day <= totalDays; day += 1) {
        const variables: Variable[] = [
          { name: variableName(personIndex, day, shift), coef: 1 },
        ]
        if (day > 1) {
          variables.push({ name: variableName(personIndex, day - 1, shift), coef: -1 })
        }
        if (day < totalDays) {
          variables.push({ name: variableName(personIndex, day + 1, shift), coef: -1 })
        }
        addUpper(`minrun_${personIndex}_${day}_${shift}`, variables, 0)
      }
    }
  }

  if (rules.maxConsecutiveWork) {
    for (let personIndex = 0; personIndex < staff.length; personIndex += 1) {
      for (let start = 1; start <= totalDays - 4; start += 1) {
        const variables: Variable[] = []
        for (let day = start; day < start + 5; day += 1) {
          for (const shift of WORK_SHIFTS) {
            variables.push({ name: variableName(personIndex, day, shift), coef: 1 })
          }
        }
        addUpper(`maxworkrun_${personIndex}_${start}`, variables, 4)
      }
    }
  }

  if (rules.nightRunLength) {
    for (let personIndex = 0; personIndex < staff.length; personIndex += 1) {
      for (let start = 1; start <= totalDays - 3; start += 1) {
        addUpper(
          `maxnightrun_${personIndex}_${start}`,
          Array.from({ length: 4 }, (_, offset) => ({
            name: variableName(personIndex, start + offset, 'N'),
            coef: 1,
          })),
          3,
        )
      }
    }
  }

  for (let personIndex = 0; personIndex < staff.length; personIndex += 1) {
    const vacations = new Set(staff[personIndex].vacations)
    for (let day = 1; day < totalDays; day += 1) {
      if (rules.noNightBeforeVacation && vacations.has(day + 1)) {
        addFixed(
          `nightbeforevac_${personIndex}_${day}`,
          [{ name: variableName(personIndex, day, 'N'), coef: 1 }],
          0,
        )
      }
      if (rules.nightFollowup) {
        if (vacations.has(day + 1)) {
          addFixed(
            `nightfollowvac_${personIndex}_${day}`,
            [{ name: variableName(personIndex, day, 'N'), coef: 1 }],
            0,
          )
        } else {
          for (const nextShift of ['D', 'E', 'S'] as const) {
            addUpper(
              `nightfollow_${personIndex}_${day}_${nextShift}`,
              [
                { name: variableName(personIndex, day, 'N'), coef: 1 },
                { name: variableName(personIndex, day + 1, nextShift), coef: 1 },
              ],
              1,
            )
          }
        }
      }
    }
  }

  if (rules.noEveningDay) {
    for (let personIndex = 0; personIndex < staff.length; personIndex += 1) {
      for (let day = 1; day < totalDays; day += 1) {
        addUpper(
          `eveningday_${personIndex}_${day}`,
          [
            { name: variableName(personIndex, day, 'E'), coef: 1 },
            { name: variableName(personIndex, day + 1, 'D'), coef: 1 },
          ],
          1,
        )
      }
    }
  }

  if (rules.noNightOffDay) {
    for (let personIndex = 0; personIndex < staff.length; personIndex += 1) {
      for (let day = 1; day <= totalDays - 2; day += 1) {
        addUpper(
          `nightoffday_${personIndex}_${day}`,
          [
            { name: variableName(personIndex, day, 'N'), coef: 1 },
            { name: variableName(personIndex, day + 2, 'D'), coef: 1 },
            ...WORK_SHIFTS.map((shift) => ({
              name: variableName(personIndex, day + 1, shift),
              coef: -1,
            })),
          ],
          1,
        )
      }
    }
  }

  const workTotals = staff.map((_, personIndex) =>
    sumFor(personIndex, totalDays, WORK_SHIFTS))
  const nightTotals = staff.map((_, personIndex) =>
    sumFor(personIndex, totalDays, ['N']))
  const dayTotals = staff.map((_, personIndex) =>
    sumFor(personIndex, totalDays, ['D']))
  const eveningTotals = staff.map((_, personIndex) =>
    sumFor(personIndex, totalDays, ['E']))
  const specialTotals = staff.map((_, personIndex) =>
    sumFor(personIndex, totalDays, ['S']))

  const addGlobalDifferenceLimit = (
    prefix: string,
    totals: Variable[][],
    maximumDifference: number,
  ) => {
    const floorVariable = `floor_${prefix}`
    bounds.push({
      name: floorVariable,
      type: glpk.GLP_DB,
      lb: 0,
      ub: totalDays,
    })
    for (let personIndex = 0; personIndex < totals.length; personIndex += 1) {
      const relativeTotal = [
        ...totals[personIndex],
        { name: floorVariable, coef: -1 },
      ]
      addLower(`${prefix}_${personIndex}_minimum`, relativeTotal, 0)
      addUpper(`${prefix}_${personIndex}_maximum`, relativeTotal, maximumDifference)
    }
  }

  if (rules.workBalance) addGlobalDifferenceLimit('workbalance', workTotals, 1)
  if (rules.nightBalance) addGlobalDifferenceLimit('nightbalance', nightTotals, 1)
  if (rules.dayEveningBalance) {
    addGlobalDifferenceLimit('daybalance', dayTotals, 2)
    addGlobalDifferenceLimit('eveningbalance', eveningTotals, 2)
  }
  if (rules.specialBalance) addGlobalDifferenceLimit('specialbalance', specialTotals, 2)

  // 역할과 휴가가 완전히 같은 직원은 이름만 바꾼 동일 해가 매우 많습니다.
  // 월 근무량의 정렬 순서를 하나로 고정해 불필요한 대칭 탐색을 줄입니다.
  const profileKey = (person: Staff) =>
    `${person.role}:${[...new Set(person.vacations)].sort((a, b) => a - b).join(',')}`
  for (let left = 0; left < staff.length; left += 1) {
    const right = left + 1
    if (right >= staff.length || profileKey(staff[left]) !== profileKey(staff[right])) continue
    addLower(
      `symmetry_${left}_${right}`,
      [
        ...workTotals[left],
        ...workTotals[right].map((variable) => ({ ...variable, coef: -variable.coef })),
      ],
      0,
    )
  }

  return {
    name: `schedule_${year}_${month + 1}`,
    objective: {
      direction: glpk.GLP_MIN,
      name: 'feasibility',
      // 균형은 위의 명시적 차이 제한으로 보장하고, 첫 완성표에서 종료합니다.
      vars: binaries.length > 0 ? [{ name: binaries[0], coef: 0 }] : [],
    },
    subjectTo,
    bounds,
    binaries,
  }
}

const formatExpression = (variables: Variable[]) => {
  if (variables.length === 0) return '0'
  return variables.map(({ name, coef }, index) => {
    const sign = coef < 0 ? '-' : '+'
    const absolute = Math.abs(coef)
    const amount = absolute === 1 ? '' : `${absolute} `
    if (index === 0) return `${coef < 0 ? '- ' : ''}${amount}${name}`
    return `${sign} ${amount}${name}`
  }).join(' ')
}

export function serializeScheduleModel(model: LinearModel) {
  const lines = [
    model.objective.direction === MODEL_CONSTANTS.GLP_MIN ? 'Minimize' : 'Maximize',
    ` ${model.objective.name}: ${formatExpression(model.objective.vars)}`,
    'Subject To',
  ]
  for (const constraint of model.subjectTo) {
    const expression = formatExpression(constraint.vars)
    if (constraint.bnds.type === MODEL_CONSTANTS.GLP_FX) {
      lines.push(` ${constraint.name}: ${expression} = ${constraint.bnds.lb}`)
    } else if (constraint.bnds.type === MODEL_CONSTANTS.GLP_UP) {
      lines.push(` ${constraint.name}: ${expression} <= ${constraint.bnds.ub}`)
    } else if (constraint.bnds.type === MODEL_CONSTANTS.GLP_LO) {
      lines.push(` ${constraint.name}: ${expression} >= ${constraint.bnds.lb}`)
    } else if (constraint.bnds.type === MODEL_CONSTANTS.GLP_DB) {
      lines.push(` ${constraint.name}_lower: ${expression} >= ${constraint.bnds.lb}`)
      lines.push(` ${constraint.name}_upper: ${expression} <= ${constraint.bnds.ub}`)
    }
  }
  if (model.bounds?.length) {
    lines.push('Bounds')
    for (const bound of model.bounds) {
      if (bound.type === MODEL_CONSTANTS.GLP_FX) {
        lines.push(` ${bound.name} = ${bound.lb}`)
      } else if (bound.type === MODEL_CONSTANTS.GLP_LO) {
        lines.push(` ${bound.name} >= ${bound.lb}`)
      } else if (bound.type === MODEL_CONSTANTS.GLP_UP) {
        lines.push(` ${bound.name} <= ${bound.ub}`)
      } else {
        lines.push(` ${bound.lb} <= ${bound.name} <= ${bound.ub}`)
      }
    }
  }
  if (model.generals?.length) {
    lines.push('General', ...model.generals.map((name: string) => ` ${name}`))
  }
  if (model.binaries?.length) {
    lines.push('Binary', ...model.binaries.map((name: string) => ` ${name}`))
  }
  lines.push('End')
  return lines.join('\n')
}

export async function solveMilpSchedule(
  highs: HighsEngine,
  staff: Staff[],
  year: number,
  month: number,
  specialNeeds: Record<number, number>,
  requestedRules: Partial<SchedulingRules>,
  timeLimitSeconds = 90,
  fixedAssignments: FixedAssignments = {},
): Promise<MilpSolveResult> {
  const startedAt = performance.now()
  const rules = normalizeSchedulingRules(requestedRules)
  const totalDays = new Date(year, month + 1, 0).getDate()
  const model = buildScheduleModel(staff, year, month, specialNeeds, rules, fixedAssignments)
  const solved = highs.solve(serializeScheduleModel(model), {
    presolve: 'on',
    time_limit: timeLimitSeconds,
    mip_rel_gap: 0,
    output_flag: false,
  })
  const solveTimeMs = performance.now() - startedAt

  if (solved.Status === 'Infeasible') {
    return {
      status: 'infeasible',
      schedule: null,
      issues: [],
      solveTimeMs,
      detail: '활성화된 모든 조건을 동시에 만족하는 시간표가 존재하지 않습니다.',
    }
  }

  const schedule: Schedule = Object.fromEntries(staff.map((person) => [person.id, {}]))
  for (let personIndex = 0; personIndex < staff.length; personIndex += 1) {
    const person = staff[personIndex]
    for (let day = 1; day <= totalDays; day += 1) {
      if (person.vacations.includes(day)) {
        schedule[person.id][day] = 'V'
        continue
      }
      const assigned = WORK_SHIFTS.find((shift) => {
        const column = solved.Columns[variableName(personIndex, day, shift)]
        return typeof column === 'object' && column !== null && 'Primal' in column &&
          typeof column.Primal === 'number' && column.Primal > 0.5
      })
      schedule[person.id][day] = assigned || 'O'
    }
  }

  const fixedIssues: string[] = []
  for (let day = 1; day <= totalDays; day += 1) {
    for (const shift of WORK_SHIFTS) {
      for (const personId of fixedAssignments[day]?.[shift] || []) {
        if (personId && schedule[personId]?.[day] !== shift) {
          const person = staff.find((candidate) => candidate.id === personId)
          fixedIssues.push(`${day}일 ${shift} 고정 배정${person ? `(${person.name})` : ''} 미반영`)
        }
      }
    }
    for (const personId of fixedAssignments[day]?.O || []) {
      if (personId && schedule[personId]?.[day] !== 'O') {
        const person = staff.find((candidate) => candidate.id === personId)
        fixedIssues.push(`${day}일 O 고정 배정${person ? `(${person.name})` : ''} 미반영`)
      }
    }
  }
  const issues = [
    ...validateSchedule(schedule, staff, totalDays, specialNeeds, rules),
    ...fixedIssues,
  ]
  const hasCompleteSolution = solved.Status === 'Optimal' || issues.length === 0
  const verified = hasCompleteSolution && issues.length === 0
  return {
    status: verified ? 'feasible' : 'unknown',
    schedule: verified ? schedule : null,
    // 제한 시간에 나온 중간 해는 완성표가 아니므로 D/E/N 0명 같은 오류로 노출하지 않습니다.
    issues: solved.Status === 'Optimal' ? issues : [],
    solveTimeMs,
    detail: verified
      ? '모든 활성 규칙을 통과한 시간표를 완성했습니다.'
      : solved.Status === 'Optimal'
        ? '최적화 결과가 최종 규칙 검증을 통과하지 못했습니다.'
        : '제한 시간까지 완성표를 찾지 못했지만 불가능 판정은 아닙니다.',
  }
}
