import test from 'node:test';
import assert from 'node:assert/strict';
import { consultationProgress, getNextQuestion, missingInformation, relevantQuestions, routeFromGoal } from '../server/services/rule-engine.js';

test('maps articulated lorry language to C+E and asks about Category B next', () => {
  assert.equal(routeFromGoal('I want to drive an artic'), 'C+E');
  const question = getNextQuestion({ answers: { goal: 'Articulated lorry' } });
  assert.equal(question.key, 'licence');
  assert.equal(question.route, 'C+E');
});

test('preserves trailer licence categories before broader route matches', () => {
  assert.equal(routeFromGoal('I need C1+E for a horsebox and trailer'), 'C1+E');
  assert.equal(routeFromGoal('I want to drive a bus with a trailer, Category D+E'), 'D+E');
  assert.equal(routeFromGoal('Minibus with trailer, D1+E'), 'D1+E');
  assert.equal(routeFromGoal('Class 1 and Driver CPC for work'), 'C+E');
});

test('asks C1 acquisition-history question only for a 7.5 tonne route', () => {
  const state = { answers: { goal: '7.5 tonne vehicle', licence: 'Yes', held: ['C1'] } };
  assert.equal(getNextQuestion(state).key, 'age');
  assert.equal(relevantQuestions(state).some(question => question.id === 'age'), true);
  assert.equal(relevantQuestions({ answers: { goal: 'Articulated lorry' } }).some(question => question.id === 'age'), false);
});

test('CPC-only consultation skips vehicle medical and training questions', () => {
  const state = { answers: { goal: 'Get Driver CPC', licence: 'Yes', held: ['None of these'] } };
  assert.equal(getNextQuestion(state).key, 'cpc');
  assert.equal(relevantQuestions(state).some(question => question.id === 'medical'), false);
  state.answers.cpc = 'Yes, professionally';
  assert.equal(getNextQuestion(state).key, 'cpcStatus');
});

test('progress and missing fields use only questions relevant to the selected route', () => {
  const state = { answers: { goal: 'Articulated lorry' } };
  assert.equal(consultationProgress(state), Math.round(1 / relevantQuestions(state).length * 100));
  assert.equal(missingInformation(state)[0].key, 'licence');
});
