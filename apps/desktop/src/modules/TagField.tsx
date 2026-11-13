/**
 * Campo de etiquetas de una escena o un marcador (Y08).
 *
 * Las etiquetas se escriben a mano, así que la pantalla tiene que evitar que
 * se multipliquen. Hace dos cosas por eso:
 *
 *  - **Sugiere las que ya existen en el proyecto** mientras se escribe. Es lo
 *    que evita que «zona norte» y «zona-norte» convivan.
 *  - **Avisa cuando la nueva sólo se diferencia en la tilde** de una que ya
 *    está, y ofrece usar aquélla. No las funde por su cuenta: puede que el
 *    autor quiera las dos, y deshacer una fusión que nadie pidió cuesta más
 *    que confirmarla.
 *
 * Se añade con Intro o eligiendo una sugerencia, y se quita con su botón o con
 * Retroceso sobre el campo vacío, que es lo que hace cualquier campo de
 * etiquetas y lo que la gente intenta sin pensar.
 */
import { useMemo, useState } from 'react';
import { addTag, removeTag, similarTags, suggestTags, normalizeTagLabel } from '@it360/domain';
import { Button, Field, IconClose, TextInput } from '@it360/ui';

export interface TagFieldProps {
  readonly tags: readonly string[];
  /** Etiquetas que ya existen en el proyecto, para sugerir. */
  readonly available: readonly string[];
  readonly onChange: (tags: readonly string[], label: string) => void;
}

export function TagField({ tags, available, onChange }: TagFieldProps): JSX.Element {
  const [draft, setDraft] = useState('');

  const canonical = normalizeTagLabel(draft);

  const similar = useMemo(() => similarTags(available, draft), [available, draft]);

  /**
   * Sugerencias que el elemento no tiene ya.
   *
   * Las parecidas por la tilde quedan fuera: el aviso de arriba ya las ofrece,
   * y repetirlas aquí dejaría dos botones con el mismo nombre en pantalla.
   */
  const suggestions = useMemo(
    () =>
      suggestTags(available, draft)
        .filter((tag) => !tags.includes(tag) && !similar.includes(tag))
        .slice(0, 6),
    [available, draft, tags, similar],
  );

  const commit = (raw: string): void => {
    const next = addTag(tags, raw);
    if (next.length !== tags.length) {
      onChange(next, `Etiquetar como ${normalizeTagLabel(raw)}`);
    }
    setDraft('');
  };

  return (
    <div className="tag-field">
      {tags.length > 0 && (
        <ul className="tag-field__list" aria-label="Etiquetas asignadas">
          {tags.map((tag) => (
            <li key={tag} className="tag-field__tag">
              <span>{tag}</span>
              <button
                type="button"
                className="tag-field__remove"
                aria-label={`Quitar la etiqueta ${tag}`}
                onClick={() => onChange(removeTag(tags, tag), `Quitar la etiqueta ${tag}`)}
              >
                <IconClose size={10} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <Field label="Añadir etiqueta" hint="Intro para añadirla. Sirven para buscar con #.">
        {({ id, describedBy }) => (
          <TextInput
            id={id}
            size="sm"
            aria-describedby={describedBy}
            value={draft}
            placeholder="zona-norte"
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commit(draft);
              }
              // Retroceso en el campo vacío quita la última: es lo que hace
              // cualquier campo de etiquetas y lo que se intenta sin pensar.
              if (event.key === 'Backspace' && draft === '' && tags.length > 0) {
                const last = tags[tags.length - 1];
                if (last !== undefined) {
                  onChange(removeTag(tags, last), `Quitar la etiqueta ${last}`);
                }
              }
            }}
          />
        )}
      </Field>

      {similar.length > 0 && canonical !== '' && !tags.includes(canonical) && (
        <p className="tag-field__similar">
          Ya existe{' '}
          {similar.map((tag) => (
            <button
              key={tag}
              type="button"
              className="tag-field__link"
              onClick={() => commit(tag)}
            >
              {tag}
            </button>
          ))}
          . ¿Se refería a ésa?
        </p>
      )}

      {suggestions.length > 0 && draft !== '' && (
        <ul className="tag-field__suggestions" aria-label="Etiquetas del proyecto">
          {suggestions.map((tag) => (
            <li key={tag}>
              <Button size="sm" variant="ghost" onClick={() => commit(tag)}>
                {tag}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
