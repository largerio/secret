export type Step = 1 | 2 | 3 | 4;

let current = $state<Step>(1);

export function setStep(step: Step): void {
	current = step;
}

export function getStep(): Step {
	return current;
}
