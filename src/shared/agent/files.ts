export interface RuntimeStoredFile {
  id: string;
  object: "stored_file";
  session_id: string;
  filename: string;
  media_type: string;
  size: number;
  created_at: string;
}
