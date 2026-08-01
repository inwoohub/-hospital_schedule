import loadHighs from 'highs'
import highsWasmUrl from 'highs/runtime?url'

import {
  DEFAULT_SCHEDULING_RULES,
  RULE_LABELS,
  normalizeSchedulingRules,
  type SchedulingRules,
  type Staff,
} from './scheduler-core'
import { solveMilpSchedule } from './milp-scheduler'

type WorkerRequest = {
  staff: Staff[]
  year: number
  month: number
  specialNeeds: Record<number, number>
  rules: SchedulingRules
}

type Relaxation = {
  rules: Array<keyof SchedulingRules>
  title: string
  reason: string
} | null

const diagnosticRuleOrder: Array<keyof SchedulingRules> = [
  'minimumRotatingRun',
  'nightRunLength',
  'nightFollowup',
  'noNightBeforeVacation',
  'noNightOffDay',
  'maxConsecutiveWork',
  'workBalance',
  'nightBalance',
  'dayEveningBalance',
]

const requiredOnlyRules = (): SchedulingRules => ({
  ...DEFAULT_SCHEDULING_RULES,
  rolePairing: true,
  minimumRotatingRun: false,
  dayEveningBalance: false,
  maxConsecutiveWork: false,
  specialBalance: false,
  nightBalance: false,
  nightRunLength: false,
  noNightBeforeVacation: false,
  nightFollowup: false,
  noNightOffDay: false,
  workBalance: false,
})

const requiredCapacityIssue = (
  staff: Staff[],
  year: number,
  month: number,
  specialNeeds: Record<number, number>,
) => {
  const totalDays = new Date(year, month + 1, 0).getDate()
  for (let day = 1; day <= totalDays; day += 1) {
    const available = staff.filter((person) => !person.vacations.includes(day))
    const specialCount = specialNeeds[day] || 0
    const required = 6 + specialCount
    if (available.length < required) {
      return `${day}일은 휴가자를 제외하면 ${available.length}명만 근무할 수 있어 필수 인원 ${required}명을 채울 수 없습니다.`
    }
    const seniors = available.filter((person) => person.role === 'senior').length
    const requiredSeniors = 3 + (specialCount > 0 ? 1 : 0)
    if (seniors < requiredSeniors) {
      return `${day}일은 D/E/N 각 사수 1명${specialCount > 0 ? '과 S/P 사수' : ''}을 동시에 배치하려면 사수 ${requiredSeniors}명이 필요하지만 ${seniors}명만 가능합니다.`
    }
  }
  return null
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { staff, year, month, specialNeeds } = event.data
  const rules = normalizeSchedulingRules(event.data.rules)
  const capacityIssue = requiredCapacityIssue(staff, year, month, specialNeeds)

  if (capacityIssue) {
    self.postMessage({
      schedule: null,
      issues: [capacityIssue],
      relaxation: null,
      suspectedRules: [],
      failureKind: 'infeasible',
      message: `필수 인원 조건이 충돌합니다. ${capacityIssue}`,
    })
    return
  }

  try {
    const highs = await loadHighs({ locateFile: () => highsWasmUrl })
    const result = await solveMilpSchedule(
      highs,
      staff,
      year,
      month,
      specialNeeds,
      rules,
      300,
    )

    if (result.status === 'feasible' && result.schedule) {
      self.postMessage({
        schedule: result.schedule,
        issues: [],
        relaxation: null,
        suspectedRules: [],
        failureKind: null,
        message: '',
      })
      return
    }

    if (result.status === 'unknown') {
      self.postMessage({
        schedule: null,
        issues: result.issues,
        relaxation: null,
        suspectedRules: [],
        failureKind: 'unknown',
        message: result.issues.length > 0
          ? `계산 결과를 최종 검증했지만 ${result.issues.length}개 규칙이 남았습니다. 완성된 표로 반환하지 않았습니다.`
          : '5분 안에 완성표를 찾지 못했습니다. 불가능하다고 판정한 것은 아닙니다. 같은 조건으로 다시 시도하거나 선택 규칙을 줄여 주세요.',
      })
      return
    }

    // 여기부터는 GLPK가 현재 조건의 불가능을 확정한 경우에만 실행합니다.
    const requiredResult = await solveMilpSchedule(
      highs,
      staff,
      year,
      month,
      specialNeeds,
      requiredOnlyRules(),
      30,
    )

    if (requiredResult.status === 'infeasible') {
      self.postMessage({
        schedule: null,
        issues: [
          '선택 규칙을 모두 꺼도 D/E/N 각 2명, 각 타임 사수 최소 1명, 휴가, 날짜별 S/P 인원과 S/P 사수 조건을 동시에 만족할 수 없습니다.',
        ],
        relaxation: null,
        suspectedRules: [],
        failureKind: 'infeasible',
        message: '필수 규칙만으로도 시간표가 존재하지 않는 것을 계산기가 확인했습니다. 직원 수·사수 수·휴가 날짜를 확인해 주세요.',
      })
      return
    }

    if (requiredResult.status === 'unknown') {
      self.postMessage({
        schedule: null,
        issues: [],
        relaxation: null,
        suspectedRules: diagnosticRuleOrder
          .filter((rule) => rules[rule])
          .map((rule) => ({ rule, title: RULE_LABELS[rule] })),
        failureKind: 'unknown',
        message: '현재 선택 규칙 조합은 불가능하지만, 필수 규칙만 남긴 진단 계산이 제한 안에 끝나지 않았습니다.',
      })
      return
    }

    let relaxation: Relaxation = null
    const activeDiagnosticRules = diagnosticRuleOrder.filter((rule) => rules[rule])
    const unresolvedRules: Array<keyof SchedulingRules> = []

    // 원래 조건에서 선택 규칙을 하나씩 정확히 제외해 실제 완성 여부를 확인합니다.
    for (const rule of activeDiagnosticRules) {
      const diagnostic = await solveMilpSchedule(
        highs,
        staff,
        year,
        month,
        specialNeeds,
        { ...rules, [rule]: false },
        20,
      )
      if (diagnostic.status === 'feasible') {
        relaxation = {
          rules: [rule],
          title: RULE_LABELS[rule],
          reason: `${RULE_LABELS[rule]} 규칙 하나를 제외한 실제 계산에서 나머지 모든 규칙을 통과한 시간표를 확인했습니다.`,
        }
        break
      }
      if (diagnostic.status === 'unknown') unresolvedRules.push(rule)
    }

    self.postMessage({
      schedule: null,
      issues: relaxation
        ? [`${relaxation.title} 규칙과 현재 직원·휴가·다른 선택 규칙의 조합이 충돌합니다.`]
        : ['필수 규칙만으로는 시간표를 만들 수 있지만, 현재 선택 규칙을 함께 적용하면 가능한 조합이 없습니다.'],
      relaxation,
      suspectedRules: (relaxation ? relaxation.rules : activeDiagnosticRules)
        .map((rule) => ({ rule, title: RULE_LABELS[rule] })),
      failureKind: 'infeasible',
      message: relaxation
        ? `${relaxation.title} 규칙을 제외하면 완성 가능한 시간표가 존재합니다.`
        : unresolvedRules.length > 0
          ? `현재 선택 규칙 조합은 불가능합니다. 다만 ${unresolvedRules.length}개 단일 규칙 진단은 제한 안에 끝나지 않아 하나의 원인으로 좁히지 못했습니다.`
          : '한 가지 선택 규칙만 제외해서는 해결되지 않았습니다. 둘 이상의 선택 규칙이 함께 충돌합니다.',
    })
  } catch (error) {
    self.postMessage({
      schedule: null,
      issues: [],
      relaxation: null,
      suspectedRules: [],
      failureKind: 'error',
      message: error instanceof Error
        ? `계산기를 실행하지 못했습니다: ${error.message}`
        : '시간표 계산기를 실행하지 못했습니다.',
    })
  }
}
