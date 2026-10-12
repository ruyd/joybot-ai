import { describe, expect, it } from 'vitest';
import { pageList } from '../src/components/ui';

describe('pageList', () => {
  it('shows every page when there are few', () => {
    expect(pageList(1, 1)).toEqual([1]);
    expect(pageList(2, 4)).toEqual([1, 2, 3, 4]);
  });
  it('shows the ends and the current page with its neighbours, with gaps', () => {
    expect(pageList(1, 21)).toEqual([1, 2, null, 21]);
    expect(pageList(10, 21)).toEqual([1, null, 9, 10, 11, null, 21]);
    expect(pageList(21, 21)).toEqual([1, null, 20, 21]);
  });
  it('fills a one-page gap instead of an ellipsis', () => {
    expect(pageList(4, 21)).toEqual([1, 2, 3, 4, 5, null, 21]);
    expect(pageList(18, 21)).toEqual([1, null, 17, 18, 19, 20, 21]);
  });
});
