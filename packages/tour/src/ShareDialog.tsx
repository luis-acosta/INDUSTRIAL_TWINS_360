/**
 * Compartir la vista actual (S09).
 *
 * Quien enseña una planta por videollamada necesita decir «mira esto». Esto le
 * da el enlace que abre la escena correcta mirando hacia donde él mira.
 *
 * El enlace se muestra entero y seleccionado, además de ofrecer el botón de
 * copiar: el portapapeles del navegador falla en bastantes sitios —sin HTTPS,
 * dentro de un marco, con permisos restringidos— y un botón «Copiar» que no
 * copia y no lo dice deja a la persona pegando lo que tenía antes. Si falla,
 * el enlace sigue a la vista para copiarlo a mano.
 */
import { useEffect, useRef, useState } from 'react';
import { Button, Callout, Checkbox, Dialog, TextInput } from '@it360/ui';
import type { CameraView } from '@it360/domain';
import { buildShareUrl } from './deep-link';

export interface ShareDialogProps {
  readonly open: boolean;
  readonly sceneId: string;
  readonly sceneTitle: string;
  readonly view: CameraView | null;
  readonly onClose: () => void;
}

type CopyState = 'idle' | 'copied' | 'failed';

export function ShareDialog({
  open,
  sceneId,
  sceneTitle,
  view,
  onClose,
}: ShareDialogProps): JSX.Element {
  const [withView, setWithView] = useState(true);
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const inputRef = useRef<HTMLInputElement | null>(null);

  const href = globalThis.location?.href ?? '';
  const url = buildShareUrl(href, sceneId, withView ? view : null);

  // Al abrirse, el enlace queda seleccionado: copiar a mano es un atajo de
  // teclado, no una selección a pulso.
  useEffect(() => {
    if (open) {
      setCopyState('idle');
      inputRef.current?.select();
    }
  }, [open, url]);

  const copy = async (): Promise<void> => {
    try {
      await globalThis.navigator?.clipboard?.writeText(url);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
      inputRef.current?.select();
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Compartir esta vista"
      description={`Abre «${sceneTitle}»${withView ? ' mirando hacia donde usted mira' : ''}.`}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cerrar
          </Button>
          <Button variant="primary" onClick={() => void copy()}>
            Copiar enlace
          </Button>
        </>
      }
    >
      <TextInput
        ref={inputRef}
        value={url}
        readOnly
        aria-label="Enlace a esta vista"
        onFocus={(event) => event.currentTarget.select()}
      />

      <Checkbox
        label="Incluir la orientación de la cámara"
        checked={withView}
        disabled={view === null}
        onChange={(event) => setWithView(event.currentTarget.checked)}
      />

      {copyState === 'copied' && (
        <Callout tone="nominal" title="Enlace copiado">
          Ya se puede pegar en un correo o en un chat.
        </Callout>
      )}

      {copyState === 'failed' && (
        <Callout tone="warning" title="El navegador no dejó copiar">
          El enlace está seleccionado arriba: cópielo con Ctrl+C.
        </Callout>
      )}

      <p className="share__hint">
        El enlace sólo funciona para quien pueda abrir este mismo recorrido publicado.
      </p>
    </Dialog>
  );
}
