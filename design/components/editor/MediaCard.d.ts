export interface MediaCardProps {
  name: string;
  duration: string;
  size: string;
  /** Thumbnail gradient stops. */
  from?: string;
  to?: string;
  selected?: boolean;
  draggable?: boolean;
  onClick?: () => void;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
  style?: React.CSSProperties;
}

/** A draggable clip tile in the media library grid. */
export function MediaCard(props: MediaCardProps): JSX.Element;
