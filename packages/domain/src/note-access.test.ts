/**
 * Pruebas del recorte de notas por categoría (P04).
 *
 * El modelo de acceso del servicio tenía el ámbito por categoría de nota desde
 * la etapa 11 y nada lo aplicaba: las notas viven en el archivo del proyecto y
 * ninguna pantalla las recortaba.
 *
 * El caso que esto resuelve es un contratista que trabaja sobre el mismo
 * proyecto y no tiene por qué ver las notas internas de mantenimiento. Y lo
 * que estas pruebas fijan, sobre todo, es la diferencia entre «sin
 * restricción» y «ninguna categoría»: confundirlas convierte el control en un
 * filtro que no filtra, o en uno que lo oculta todo.
 */
import { describe, expect, it } from 'vitest';

import {
  categoriesAvailableTo,
  hiddenNoteCount,
  notesVisibleTo,
  type NoteCategory,
} from './note';
import { makeNote, testUuid } from './testing';

const PROJECT = testUuid(1);

const CATEGORIES: NoteCategory[] = [
  { id: 'safety', label: 'Seguridad', colorToken: 'alarm', description: '' },
  { id: 'maintenance', label: 'Mantenimiento', colorToken: 'warning', description: '' },
  { id: 'other', label: 'Otras', colorToken: 'neutral', description: '' },
];

const NOTES = [
  makeNote(80, PROJECT, { categoryId: 'safety', title: 'Fuga en la brida' }),
  makeNote(81, PROJECT, { categoryId: 'maintenance', title: 'Cambiar rodamiento' }),
  makeNote(82, PROJECT, { categoryId: 'other', title: 'Revisar rótulo' }),
];

describe('notesVisibleTo', () => {
  it('sin restricción se ven todas', () => {
    // TEST-NAC-001: `null` es «sin restricción». Si significara «ninguna», un
    // usuario con permisos generales se quedaría sin ver nota alguna, que es
    // el modo de fallo más fácil de cometer aquí y el más desconcertante.
    expect(notesVisibleTo(NOTES, null)).toHaveLength(3);
  });

  it('con categorías concedidas se ven sólo esas', () => {
    // TEST-NAC-002: el caso del contratista.
    expect(notesVisibleTo(NOTES, ['safety']).map((note) => note.title)).toEqual([
      'Fuga en la brida',
    ]);
  });

  it('una lista vacía oculta todas', () => {
    // TEST-NAC-003: es un estado legítimo —lectura del recorrido y de ninguna
    // categoría de notas— y distinto de «sin restricción».
    expect(notesVisibleTo(NOTES, [])).toHaveLength(0);
  });

  it('varias categorías concedidas se acumulan', () => {
    // TEST-NAC-004: un usuario con dos roles ve la unión de lo que cada uno
    // le concede, no la intersección: los permisos suman.
    expect(notesVisibleTo(NOTES, ['safety', 'other'])).toHaveLength(2);
  });

  it('una categoría concedida que no existe no añade nada', () => {
    // TEST-NAC-005: ocurre cuando el administrador concede una categoría que
    // el proyecto todavía no tiene; no debe producir huecos ni errores.
    expect(notesVisibleTo(NOTES, ['safety', 'inexistente'])).toHaveLength(1);
  });

  it('conserva el orden original', () => {
    // TEST-NAC-006: el panel ordena por su cuenta; si el recorte reordenara,
    // la lista daría saltos al cambiar de usuario.
    const visible = notesVisibleTo(NOTES, ['other', 'safety']);
    expect(visible.map((note) => note.categoryId)).toEqual(['safety', 'other']);
  });
});

describe('categoriesAvailableTo', () => {
  it('ofrece sólo las categorías visibles', () => {
    // TEST-NAC-007: ofrecer una que luego no se puede ver dejaría al autor
    // creando notas que desaparecen al guardarlas, lo que parece una pérdida
    // de datos y hace desconfiar del programa.
    expect(categoriesAvailableTo(CATEGORIES, ['safety', 'other']).map((c) => c.id)).toEqual([
      'safety',
      'other',
    ]);
  });

  it('sin restricción ofrece todas', () => {
    // TEST-NAC-008
    expect(categoriesAvailableTo(CATEGORIES, null)).toHaveLength(3);
  });

  it('con restricción vacía no ofrece ninguna', () => {
    // TEST-NAC-009: y entonces la pantalla tiene que explicar por qué no se
    // puede crear una nota, en lugar de mostrar un desplegable vacío.
    expect(categoriesAvailableTo(CATEGORIES, [])).toEqual([]);
  });
});

describe('hiddenNoteCount', () => {
  it('cuenta lo que queda fuera', () => {
    // TEST-NAC-010: una lista recortada en silencio hace pensar que el
    // proyecto está incompleto, y alguien acaba creando otra vez una nota que
    // ya existía y no podía ver.
    expect(hiddenNoteCount(NOTES, ['safety'])).toBe(2);
  });

  it('no cuenta nada sin restricción', () => {
    // TEST-NAC-011: y entonces la pantalla no dice nada, que es lo correcto.
    expect(hiddenNoteCount(NOTES, null)).toBe(0);
  });
});
