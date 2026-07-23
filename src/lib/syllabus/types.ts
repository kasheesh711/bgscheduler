export interface Skill {
  code: string;
  description: string;
}

export interface Topic {
  code: string;
  name: string;
  skills: Skill[];
}

export interface YearSyllabus {
  year: number;
  topics: Topic[];
}

export interface TopicSummary {
  code: string;
  name: string;
  skillCount: number;
}

export interface YearSummary {
  year: number;
  topicCount: number;
  skillCount: number;
  topics: TopicSummary[];
}
