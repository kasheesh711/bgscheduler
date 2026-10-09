import {describe,it,expect} from 'vitest';
import {courseExclusion,recentAttendance,regularGroupCourseIds,seasonalCourseIds,recentClassWindowMs} from '../course-policy';
describe('course eligibility policy',()=>{
 const now=new Date('2026-10-10T00:00:00Z');
 it('includes the exact 60-day boundary but excludes older, missing, and future attendance',()=>{
  expect(recentAttendance(new Date(now.getTime()-recentClassWindowMs),now)).toBe(true);
  expect(recentAttendance(new Date(now.getTime()-recentClassWindowMs-1),now)).toBe(false);
  expect(recentAttendance(new Date(now.getTime()+1),now)).toBe(false);
  expect(recentAttendance(null,now)).toBe(false);
  expect(recentAttendance(new Date('invalid'),now)).toBe(false);
 });
 it('excludes all thirteen reviewed seasonal courses and keeps nine reviewed regular groups',()=>{
  expect(new Set(seasonalCourseIds).size).toBe(13);expect(new Set(regularGroupCourseIds).size).toBe(9);
  for(const id of seasonalCourseIds)expect(courseExclusion(id,'LIVE')).toContain('Seasonal');
  for(const id of regularGroupCourseIds)expect(courseExclusion(id,'LIVE')).toBeNull();
  expect(courseExclusion('new-group','LIVE')).toContain('review');
  expect(courseExclusion('one','ONE_TO_ONE')).toBeNull();expect(courseExclusion('one',null)).toContain('type');
 });
});
