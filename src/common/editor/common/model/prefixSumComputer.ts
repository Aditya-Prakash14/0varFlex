// src/common/editor/common/model/prefixSumComputer.ts — ported from
// vs/editor/common/model/prefixSumComputer.ts (the first class + result type; the constant-time
// variant is a delta). This is the offset-math engine: cumulative line lengths with lazy
// prefix-sum computation and binary search.

export class PrefixSumComputer {

	/**
	 * values[i] is the value at index i
	 */
	private values: Uint32Array;

	/**
	 * prefixSum[i] = SUM(values[j]), 0 <= j <= i
	 */
	private prefixSum: Uint32Array;

	/**
	 * prefixSum[i], 0 <= i <= prefixSumValidIndex can be trusted
	 */
	private readonly prefixSumValidIndex: Int32Array;

	constructor(values: Uint32Array) {
		this.values = values;
		this.prefixSum = new Uint32Array(values.length);
		this.prefixSumValidIndex = new Int32Array(1);
		this.prefixSumValidIndex[0] = -1;
	}

	getCount(): number {
		return this.values.length;
	}

	insertValues(insertIndex: number, insertValues: Uint32Array): boolean {
		insertIndex = insertIndex >>> 0;
		const oldValues = this.values;
		const oldPrefixSum = this.prefixSum;
		const insertValuesLen = insertValues.length;

		if (insertValuesLen === 0) {
			return false;
		}

		this.values = new Uint32Array(oldValues.length + insertValuesLen);
		this.values.set(oldValues.subarray(0, insertIndex), 0);
		this.values.set(oldValues.subarray(insertIndex), insertIndex + insertValuesLen);
		this.values.set(insertValues, insertIndex);

		if (insertIndex - 1 < this.prefixSumValidIndex[0]) {
			this.prefixSumValidIndex[0] = insertIndex - 1;
		}

		this.prefixSum = new Uint32Array(this.values.length);
		if (this.prefixSumValidIndex[0] >= 0) {
			this.prefixSum.set(oldPrefixSum.subarray(0, this.prefixSumValidIndex[0] + 1));
		}
		return true;
	}

	setValue(index: number, value: number): boolean {
		index = index >>> 0;
		value = value >>> 0;

		if (this.values[index] === value) {
			return false;
		}
		this.values[index] = value;
		if (index - 1 < this.prefixSumValidIndex[0]) {
			this.prefixSumValidIndex[0] = index - 1;
		}
		return true;
	}

	removeValues(startIndex: number, count: number): boolean {
		startIndex = startIndex >>> 0;
		count = count >>> 0;

		const oldValues = this.values;
		const oldPrefixSum = this.prefixSum;

		if (startIndex >= oldValues.length) {
			return false;
		}

		const maxCount = oldValues.length - startIndex;
		if (count >= maxCount) {
			count = maxCount;
		}

		if (count === 0) {
			return false;
		}

		this.values = new Uint32Array(oldValues.length - count);
		this.values.set(oldValues.subarray(0, startIndex), 0);
		this.values.set(oldValues.subarray(startIndex + count), startIndex);

		this.prefixSum = new Uint32Array(this.values.length);
		if (startIndex - 1 < this.prefixSumValidIndex[0]) {
			this.prefixSumValidIndex[0] = startIndex - 1;
		}
		if (this.prefixSumValidIndex[0] >= 0) {
			this.prefixSum.set(oldPrefixSum.subarray(0, this.prefixSumValidIndex[0] + 1));
		}
		return true;
	}

	getTotalSum(): number {
		if (this.values.length === 0) {
			return 0;
		}
		return this._getPrefixSum(this.values.length - 1);
	}

	/**
	 * @returns SUM(0 <= j <= index, values[j])
	 */
	getPrefixSum(index: number): number {
		if (index < 0) {
			return 0;
		}
		index = index >>> 0;
		return this._getPrefixSum(index);
	}

	private _getPrefixSum(index: number): number {
		if (index <= this.prefixSumValidIndex[0]) {
			return this.prefixSum[index];
		}

		let startIndex = this.prefixSumValidIndex[0] + 1;
		if (startIndex === 0) {
			this.prefixSum[0] = this.values[0];
			startIndex++;
		}

		if (index >= this.values.length) {
			index = this.values.length - 1;
		}

		for (let i = startIndex; i <= index; i++) {
			this.prefixSum[i] = this.prefixSum[i - 1] + this.values[i];
		}
		this.prefixSumValidIndex[0] = Math.max(this.prefixSumValidIndex[0], index);
		return this.prefixSum[index];
	}

	/**
	 * @returns `result` such that `getPrefixSum(result.index) - values[result.index] + result.remainder === sum`
	 */
	getIndexOf(sum: number): PrefixSumIndexOfResult {
		sum = Math.floor(sum);

		// compute all sums (to get a fully valid prefixSum)
		this.getTotalSum();

		let low = 0;
		let high = this.values.length - 1;
		let mid = 0;
		let midStop = 0;
		let midStart = 0;

		while (low <= high) {
			mid = low + ((high - low) / 2) | 0;

			midStop = this.prefixSum[mid];
			midStart = midStop - this.values[mid];

			if (sum < midStart) {
				high = mid - 1;
			} else if (sum >= midStop) {
				low = mid + 1;
			} else {
				break;
			}
		}

		return new PrefixSumIndexOfResult(mid, sum - midStart);
	}
}

export class PrefixSumIndexOfResult {

	_prefixSumIndexOfResultBrand: void = undefined;

	constructor(
		readonly index: number,
		readonly remainder: number
	) { }
}
