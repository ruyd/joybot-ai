import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Select } from '../src/components/Select';

function Picker({ onPick }: { onPick: (v: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <label>
      Method
      <Select
        required
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          onPick(e.target.value);
        }}
      >
        <option value="">Choose…</option>
        <option value="card">Card</option>
        <>
          <option value="cash" disabled>
            Cash
          </option>
          {['bank'].map((v) => (
            <option key={v} value={v}>
              Bank transfer
            </option>
          ))}
        </>
      </Select>
    </label>
  );
}

afterEach(cleanup);

describe('Select', () => {
  it('opens from its label, lists the options with the chosen one checked, and reports the value', () => {
    const onPick = vi.fn();
    render(<Picker onPick={onPick} />);
    fireEvent.click(screen.getByText('Method'));
    // Outside the label: there, choosing an option would also click the label and reopen the list.
    expect(screen.getByRole('listbox').closest('label')).toBeNull();
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['Choose…', 'Card', 'Cash', 'Bank transfer']);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(options[2]).toHaveAttribute('aria-disabled', 'true');

    fireEvent.click(options[2]); // disabled: nothing happens
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.click(options[3]);
    expect(onPick).toHaveBeenCalledWith('bank');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('button', { name: /Method/ })).toHaveTextContent('Bank transfer');
  });

  it('works from the keyboard and skips disabled options', () => {
    const onPick = vi.fn();
    render(<Picker onPick={onPick} />);
    const button = screen.getByRole('button', { name: /Method/ });
    fireEvent.keyDown(button, { key: 'ArrowDown' });
    const list = screen.getByRole('listbox');
    fireEvent.keyDown(list, { key: 'ArrowDown' }); // Card
    fireEvent.keyDown(list, { key: 'ArrowDown' }); // Cash is disabled: Bank transfer
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith('bank');
  });

  it('keeps a native select for form validation', () => {
    const { container } = render(<Picker onPick={() => undefined} />);
    const native = container.querySelector('select')!;
    expect(native).toBeRequired();
    expect(native.value).toBe('');
    expect(native.checkValidity()).toBe(false);
  });
});
