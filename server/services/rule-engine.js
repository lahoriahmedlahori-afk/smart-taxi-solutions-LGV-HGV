const stages = [
  'Customer details', 'Goal identified', 'Licence checked', 'Eligibility information', 'Medical',
  'Provisional entitlement', 'Theory tests', 'CPC requirement', 'Practical training',
  'Location / availability', 'Package recommendation', 'Quote', 'Objections', 'Closing', 'Follow-up / booking',
];

const questions = [
  { id: 'goal', stage: 1, title: 'What would you like to be able to drive or do?', why: 'The vehicle and intended use point us toward a likely licence route and whether professional CPC questions apply.', options: ['Articulated lorry', 'Rigid lorry', '7.5 tonne vehicle', 'Bus or coach', 'Minibus', 'Drive professionally', 'Upgrade my licence', 'Get Driver CPC', 'Not sure'], type: 'goal', priority: 'HIGH' },
  { id: 'licence', stage: 2, title: 'Do you hold a full UK car (Category B) driving licence?', why: 'This helps establish the starting point. Verify actual entitlements rather than infer them from age or dates.', options: ['Yes', 'No', 'Not sure'], type: 'choice', priority: 'HIGH' },
  { id: 'held', stage: 2, title: 'Which relevant categories are currently shown on your licence?', why: 'Existing C1, C, C+E, D or D1 entitlement can change the next steps. Ask the customer to check the official record.', options: ['C1', 'C', 'C+E', 'D1', 'D', 'None of these', 'Not sure'], type: 'multi', priority: 'HIGH' },
  { id: 'age', stage: 3, title: 'What is your age, and when did you first obtain Category B?', why: 'Age and licence dates can affect what needs checking, but are not enough to establish entitlement. Verify the record against current DVLA guidance.', options: ['Record details'], type: 'text', priority: 'MEDIUM' },
  { id: 'medical', stage: 4, title: 'Have you completed the required commercial driver medical (D4), or is one booked?', why: 'Medical and provisional steps may be needed. Do not assess medical fitness; refer questions to DVLA or an appropriate medical professional.', options: ['Completed', 'Booked', 'Not yet', 'Not sure'], type: 'choice', priority: 'HIGH' },
  { id: 'provisional', stage: 5, title: 'Does your licence show provisional entitlement for the category you want?', why: 'Confirm the correct provisional entitlement before finalising a training or test booking.', options: ['Yes', 'No', 'Not sure'], type: 'choice', priority: 'HIGH' },
  { id: 'theory', stage: 6, title: 'What is the status of your theory and hazard perception tests?', why: 'Requirements depend on route and prior qualifications. Track each result and verify validity before relying on it.', options: ['Both passed', 'Booked', 'Some passed', 'Not started', 'Not sure'], type: 'choice', priority: 'HIGH' },
  { id: 'cpc', stage: 7, title: 'Will you drive commercially as part of your work?', why: 'Professional use can affect Driver CPC requirements. Verify current GOV.UK / DVSA guidance and exemptions.', options: ['Yes, professionally', 'No, private use', 'Not sure'], type: 'choice', priority: 'HIGH' },
  { id: 'cpcStatus', stage: 7, title: 'What Driver CPC qualification or modules do you need, or already hold?', why: 'Initial Module 2 / Module 4 and periodic CPC are different routes. Verify the customer’s current qualification and hours.', options: ['Initial Driver CPC', 'Module 2 passed', 'Module 4 passed', 'Periodic training', 'Not sure'], type: 'multi', priority: 'HIGH' },
  { id: 'experience', stage: 8, title: 'How much relevant large-vehicle driving or training have you done?', why: 'Experience and confidence help choose an assessment, refresher or standard/extended course. No hour band guarantees a pass.', options: ['No experience', 'Some training', 'UK HGV experience', 'International experience', 'Need refresher'], type: 'choice', priority: 'MEDIUM' },
  { id: 'location', stage: 9, title: 'Which training area and dates would work best for you?', why: 'Location and availability let us compare suitable partner centres and realistic course dates.', options: ['Enter preferred area or dates'], type: 'text', priority: 'MEDIUM' },
  { id: 'budget', stage: 10, title: 'Have you set a budget or payment preference for training?', why: 'This helps tailor an itemised package and explain deposit and balance options clearly, without pressure.', options: ['Share budget / payment preference'], type: 'text', priority: 'LOW' },
  { id: 'objection', stage: 12, title: 'What questions or concerns would you like us to clear up before a quote?', why: 'Clarify the concern and answer it accurately, with package inclusions and terms in writing.', options: ['Price', 'Time away from work', 'Passing the test', 'What is included', 'No concerns', 'Other'], type: 'choice', priority: 'MEDIUM' },
  { id: 'close', stage: 13, title: 'Would you like me to prepare a quote or check the next available course dates?', why: 'Agree a practical next action: quote, availability check, document checklist or a no-pressure follow-up.', options: ['Prepare a quote', 'Check course dates', 'Send document checklist', 'Schedule follow-up', 'Not ready yet'], type: 'choice', priority: 'LOW' },
];

function goalText(state) {
  const goal = state.answers?.goal;
  return [Array.isArray(goal) ? goal.join(' ') : goal, state.questionNotes?.goal, state.goal].filter(Boolean).join(' ').toLowerCase();
}

export function routeFromGoal(value) {
  const text = String(value || '').toLowerCase().replace(/\s+/g, ' ');
  if (/c1\s*\+\s*e|c1\+e/.test(text)) return 'C1+E';
  if (/d1\s*\+\s*e|d1\+e|d1.*trailer|minibus.*trailer/.test(text)) return 'D1+E';
  if (/d\s*\+\s*e|d\+e|bus.*trailer|coach.*trailer/.test(text)) return 'D+E';
  if (/artic|articulated|class\s*1|c\s*\+\s*e|c\+e/.test(text)) return 'C+E';
  if (/minibus|\bd1\b/.test(text)) return 'D1';
  if (/coach|bus|category d\b/.test(text)) return 'D';
  if (/7[.,]?5\s*(tonne|ton|t)?|\bc1\b|ambulance|horsebox|recovery/.test(text)) return 'C1';
  if (/rigid|class\s*2|category c\b|\bhgv\b|\blgv\b|lorry|truck/.test(text)) return 'C';
  if (/get driver cpc|driver cpc|periodic cpc|module\s*[24]|\bcpc\b/.test(text)) return 'Driver CPC';
  return '';
}

export function relevantQuestions(state) {
  const goal = goalText(state);
  const route = routeFromGoal(goal);
  const cpcOnly = route === 'Driver CPC';
  return questions.filter(question => {
    if (question.id === 'age') return route === 'C1' || route === 'C1+E';
    if (['medical', 'provisional', 'theory', 'experience'].includes(question.id)) return !cpcOnly;
    if (question.id === 'cpc') return !/private use|personal use|not professional/.test(goal) || cpcOnly;
    if (question.id === 'cpcStatus') return cpcOnly || state.answers?.cpc === 'Yes, professionally' || /cpc|module\s*[24]|periodic/.test(goal);
    return true;
  });
}

export function consultationProgress(state) {
  const active = relevantQuestions(state);
  const answered = active.filter(question => state.answers?.[question.id] !== undefined).length;
  return Math.round(answered / Math.max(active.length, 1) * 100);
}

export function missingInformation(state) {
  return relevantQuestions(state).filter(question => state.answers?.[question.id] === undefined).map(question => ({
    key: question.id,
    label: question.title,
    stage: stages[question.stage] || stages[0],
    priority: question.priority,
  }));
}

export function getNextQuestion(state) {
  const route = routeFromGoal(goalText(state));
  const active = relevantQuestions(state);
  const next = active.find(question => state.answers?.[question.id] === undefined);
  if (!next) return null;
  return {
    key: next.id,
    question: next.title,
    whyAsked: next.why,
    answerOptions: next.options,
    type: next.type,
    stage: stages[next.stage] || stages[0],
    stageIndex: next.stage,
    priority: next.priority,
    route: route || null,
    regulatoryWarning: next.id === 'medical'
      ? 'Medical eligibility must be confirmed by DVLA or an appropriate medical professional.'
      : ['licence', 'held', 'age', 'provisional', 'theory', 'cpc', 'cpcStatus'].includes(next.id)
        ? 'Verify licence, test and CPC requirements against current DVLA / DVSA / GOV.UK guidance before booking.'
        : null,
    suggestedExplanation: next.id === 'goal'
      ? 'I’ll check the likely route against what you want to drive and the entitlement shown on your record.'
      : 'This helps us identify the right next step; we will confirm details before booking.',
    salesOpportunity: next.id === 'budget'
      ? 'Offer an itemised estimate with deposit, balance, inclusions and terms clearly stated.'
      : next.id === 'location'
        ? 'Compare partner-centre availability and total customer price for the preferred area.'
        : 'Keep any recommendation tied to the customer’s stated goal and verified requirements.',
    confidence: route ? 0.72 : 0.4,
  };
}

export function validateAnswer(questionKey, answer) {
  const question = questions.find(item => item.id === questionKey);
  if (!question) return false;
  if (answer === 'Not answered') return true;
  if (question.type === 'goal' || question.type === 'text') return typeof answer === 'string' && answer.trim().length > 0 && answer.length <= 800;
  if (question.type === 'multi') {
    return Array.isArray(answer) && answer.length > 0 && answer.length <= question.options.length
      && answer.every(value => typeof value === 'string' && question.options.includes(value))
      && new Set(answer).size === answer.length;
  }
  return typeof answer === 'string' && question.options.includes(answer);
}

export function consultationStages() {
  return [...stages];
}
