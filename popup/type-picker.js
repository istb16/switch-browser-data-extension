import { TYPE_LABELS } from '../lib/data-types.js';

export function buildTypePicker(types, note) {
  const content = document.createDocumentFragment();
  const fieldset = document.createElement('fieldset');
  fieldset.className = 'type-picker';
  const boxes = types.map(type => {
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = type;
    box.checked = type === 'cookies';
    const text = document.createElement('span');
    text.textContent = TYPE_LABELS[type];
    label.append(box, text);
    fieldset.append(label);
    return box;
  });
  content.append(fieldset);

  if (note) {
    const paragraph = document.createElement('p');
    paragraph.className = 'type-picker__note';
    paragraph.textContent = note;
    content.append(paragraph);
  }

  return {
    content,
    read: () => boxes.filter(box => box.checked).map(box => box.value),
  };
}
